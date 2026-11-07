/**
 * dsh-utf8-output — repair OEM-codepage output from the host subprocess service.
 *
 * Root cause it works around: @deepseek-ai/dsh-subprocess-local/lib/output.js
 * decodes collected bytes with a bare Buffer#toString("utf8"), so Windows
 * console children written in CP936/GBK (Chinese, CP932/949 alike) turn into
 * U+FFFD and the damage is irreversible.
 *
 * This plugin does NOT patch the core module. It hooks the cordis
 * "subprocess" service: every handle it returns exposes .collected.stdout /
 * .collected.stderr (OutputCollector instances keeping the raw chunks), so a
 * replacement readFrom()/finalize() can re-decode the original bytes.
 *
 * The service object is shared across plugins (cordis returns per-plugin
 * proxies over one instance), so patching it once here also covers cached
 * service references held by other plugins, e.g. dsh-ops.
 */

const REPLACEMENT = "\uFFFD";

export const name = "dsh-utf8-output";

/** cordis: wait for the service instead of racing plugin load order. */
export const inject = ["subprocess"];

/** One UTF-8 character occupies at most 4 bytes, so at most 3 bytes of a
 * cut character can survive at a window edge. */
const MAX_EDGE_DAMAGE = 3;

/**
 * @param {Buffer} buf
 * @returns {string | null} decoded text, or null when the bytes are not UTF-8
 */
function decodeUtf8Strict(buf) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		return null;
	}
}

/**
 * @param {Buffer} buf
 * @param {boolean} fatal
 * @returns {string | null}
 */
function decodeGb18030(buf, fatal) {
	try {
		return new TextDecoder("gb18030", { fatal }).decode(buf);
	} catch {
		return null;
	}
}

/**
 * GBK characters are two bytes wide. The collector keeps a tail window, so
 * the head can start mid-character (leaving one stray byte) while the tail
 * is always the newest, complete bytes. Decode aligned first, then try
 * skipping a stray lead byte; a lossy tail pass keeps any dangling byte
 * visible as one replacement character.
 * @param {Buffer} buf
 * @returns {string | null}
 */
function decodeGbk(buf) {
	if (decodeGb18030(buf, true) != null) return decodeGb18030(buf, false);
	for (let skip = 1; skip <= MAX_EDGE_DAMAGE && skip < buf.length - 1; skip += 1) {
		const head = buf.subarray(skip);
		if (decodeGb18030(head, true) != null) return decodeGb18030(head, false);
	}
	return null;
}

/**
 * @param {Buffer} buf
 * @param {boolean} headTruncated caller hint: the read starts before the
 * retained window (kept for readability; edge damage is judged from bytes)
 * @returns {string}
 */
export function decodeStreamText(buf, headTruncated) {
	void headTruncated;
	if (buf == null || buf.length === 0) return "";
	const exact = decodeUtf8Strict(buf);
	if (exact != null) return exact;
	const loose = buf.toString("utf8");
	// Edge damage only: skipping the cut bytes leaves clean UTF-8, so keep the
	// loose text (it already carries the replaced edge).
	for (let skip = 1; skip <= MAX_EDGE_DAMAGE && skip < buf.length; skip += 1) {
		if (decodeUtf8Strict(buf.subarray(skip)) != null) return loose;
	}
	for (let cut = 1; cut <= MAX_EDGE_DAMAGE && cut < buf.length; cut += 1) {
		if (decodeUtf8Strict(buf.subarray(0, buf.length - cut)) != null) return loose;
	}
	// Not UTF-8 under any edge reading: treat it as GBK.
	return decodeGbk(buf) ?? loose;
}

/**
 * Read one collector's retained raw tail and its position in the full stream.
 *
 * Host cores expose this through snapshot(); older published builds
 * (e.g. @deepseek-ai/dsh-subprocess-local 0.0.1-rc.1) keep the same chunks /
 * total fields without the method, so read them directly before giving up.
 * @param {object} collector OutputCollector instance
 * @returns {{bytes: Buffer, totalBytes: number} | null}
 */
function readTail(collector) {
	try {
		if (typeof collector.snapshot === "function") {
			const snap = collector.snapshot();
			const bytes = snap?.bytes;
			if (bytes != null && typeof bytes.subarray === "function") {
				return { bytes, totalBytes: typeof snap.totalBytes === "number" ? snap.totalBytes : bytes.length };
			}
		}
		const chunks = collector.chunks;
		if (Array.isArray(chunks) && chunks.length > 0) {
			const bytes = Buffer.concat(chunks);
			return { bytes, totalBytes: typeof collector.total === "number" ? collector.total : bytes.length };
		}
	} catch {}
	return null;
}

/**
 * Re-decode one collector's reads from its retained raw bytes.
 * @param {object} collector OutputCollector instance
 */
function patchCollector(collector) {
	if (!collector || collector.__utf8OutputPatched) return;
	try {
		Object.defineProperty(collector, "__utf8OutputPatched", { value: true, configurable: true });
	} catch {
		return;
	}
	const readFrom = typeof collector.readFrom === "function"
		? collector.readFrom.bind(collector)
		: undefined;
	if (readFrom) {
		collector.readFrom = (fromByte) => {
			const result = readFrom(fromByte);
			try {
				const tail = readTail(collector);
				if (tail == null) return result;
				const windowStart = tail.totalBytes - tail.bytes.length;
				const lossy = fromByte < windowStart;
				const slice = lossy ? tail.bytes : tail.bytes.subarray(fromByte - windowStart);
				return { ...result, text: decodeStreamText(slice, lossy), lossy };
			} catch {
				return result;
			}
		};
	}
	const finalize = typeof collector.finalize === "function"
		? collector.finalize.bind(collector)
		: undefined;
	if (finalize) {
		collector.finalize = () => {
			const result = finalize();
			try {
				const tail = readTail(collector);
				if (tail != null) {
					result.text = decodeStreamText(tail.bytes, tail.totalBytes > tail.bytes.length);
				}
			} catch {}
			return result;
		};
	}
}

/**
 * @param {object} ctx cordis context
 */
export function apply(ctx) {
	const service = ctx.get?.("subprocess") ?? ctx.subprocess;
	if (!service || typeof service.spawn !== "function") return;
	if (service.__utf8OutputBridged) return;
	try {
		Object.defineProperty(service, "__utf8OutputBridged", { value: true, configurable: true });
	} catch {
		return;
	}
	const spawn = service.spawn;
	try {
		service.spawn = function bridgedSpawn(spec) {
			const handle = spawn.call(this, spec);
			try {
				patchCollector(handle?.collected?.stdout);
				patchCollector(handle?.collected?.stderr);
			} catch {}
			return handle;
		};
	} catch {
		// A frozen service keeps the stock (lossy) behaviour instead of throwing
		// during plugin load.
	}
}