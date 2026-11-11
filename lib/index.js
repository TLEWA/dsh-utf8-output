/**
 * dsh-utf8-output — repair OEM-codepage output from the host subprocess service.
 *
 * Root cause it works around: @deepseek-ai/dsh-subprocess-local/lib/output.js
 * decodes collected bytes with a bare Buffer#toString("utf8"), so Windows
 * console children written in CP936/GBK (Chinese) turn into U+FFFD and the
 * damage is irreversible.
 *
 * This plugin does NOT patch the core module. It hooks the cordis
 * "subprocess" service: every handle it returns exposes .collected.stdout /
 * .collected.stderr (OutputCollector instances keeping the raw chunks), so a
 * replacement readFrom()/finalize() can re-decode the original bytes.
 *
 * The service object is shared across plugins (cordis returns per-plugin
 * proxies over one instance), so patching it once here also covers cached
 * service references held by other plugins, e.g. dsh-ops.
 *
 * Known limits (see README): only the GB18030/GBK (CP936) decoder is
 * implemented; other OEM code pages stay as stock output. UTF-16LE output and
 * GBK bytes that happen to be valid UTF-8 cannot be told apart from UTF-8
 * without out-of-band knowledge.
 */

const REPLACEMENT = "\uFFFD";

export const name = "dsh-utf8-output";

/** cordis: wait for the service instead of racing plugin load order. */
export const inject = ["subprocess"];

/** One UTF-8 character occupies at most 4 bytes, so at most 3 bytes of a
 * cut character can survive at a window edge. */
const MAX_EDGE_DAMAGE = 3;

// TextDecoder construction is not free, and every read would otherwise build
// up to four of them. The decoders are stateless when used with decode() and
// no { stream: true }.
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const GB18030_LOOSE = new TextDecoder("gb18030");

/**
 * @param {Buffer} buf
 * @returns {string | null} decoded text, or null when the bytes are not UTF-8
 */
function decodeUtf8Strict(buf) {
	try {
		return UTF8_STRICT.decode(buf);
	} catch {
		return null;
	}
}

/**
 * GB18030 replaces every invalid byte with U+FFFD, an ASCII-only stream can
 * never contain, so the loose decode doubles as a validity check.
 * @param {Buffer} buf
 * @returns {string | null}
 */
function decodeGb18030Loose(buf) {
	const text = GB18030_LOOSE.decode(buf);
	return text.includes(REPLACEMENT) ? null : text;
}

/**
 * Number of continuation bytes (0x80-0xBF) the buffer starts with, capped at
 * the longest possible cut multi-byte character.
 * @param {Buffer} buf
 * @returns {number}
 */
function leadingContinuationRun(buf) {
	let run = 0;
	while (run < MAX_EDGE_DAMAGE && run < buf.length && buf[run] >= 0x80 && buf[run] <= 0xbf) run += 1;
	return run;
}

/**
 * Length of an unfinished UTF-8 sequence at the end of the buffer, or 0 when
 * the last bytes form a complete character (or plain invalid bytes).
 * @param {Buffer} buf
 * @returns {number}
 */
function incompleteTailLength(buf) {
	let run = 0;
	while (run < MAX_EDGE_DAMAGE && run < buf.length && buf[buf.length - 1 - run] >= 0x80 && buf[buf.length - 1 - run] <= 0xbf) {
		run += 1;
	}
	const leadIndex = buf.length - 1 - run;
	if (leadIndex < 0) return run; // only continuation bytes survive
	const lead = buf[leadIndex];
	let need;
	if (lead >= 0xf0 && lead <= 0xf4) need = 4;
	else if (lead >= 0xe0 && lead <= 0xef) need = 3;
	else if (lead >= 0xc2 && lead <= 0xdf) need = 2;
	else return 0; // ASCII, or a lead no valid sequence uses
	const have = run + 1;
	return have < need ? have : 0;
}

/**
 * GBK characters are two bytes wide. The collector keeps a tail window, so
 * the head can start mid-character (leaving one stray byte) while the tail
 * is always the newest, complete bytes. Decode aligned first, then try
 * skipping a stray lead byte.
 * @param {Buffer} buf
 * @returns {string | null}
 */
function decodeGbk(buf) {
	const direct = decodeGb18030Loose(buf);
	if (direct != null) return direct;
	for (let skip = 1; skip <= MAX_EDGE_DAMAGE && skip < buf.length - 1; skip += 1) {
		const aligned = decodeGb18030Loose(buf.subarray(skip));
		if (aligned != null) return aligned;
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
	// Edge damage only: cutting the partial character at either edge leaves
	// clean UTF-8, so keep the loose text (it already carries the replacement).
	const head = leadingContinuationRun(buf);
	if (head > 0 && head < buf.length && decodeUtf8Strict(buf.subarray(head)) != null) return loose;
	const tail = incompleteTailLength(buf);
	if (tail > 0 && tail < buf.length && decodeUtf8Strict(buf.subarray(0, buf.length - tail)) != null) return loose;
	// Not UTF-8 under any edge reading: treat it as GBK.
	return decodeGbk(buf) ?? loose;
}

/**
 * @param {unknown} value
 * @returns {Buffer | null}
 */
function asBuffer(value) {
	if (Buffer.isBuffer(value)) return value;
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return null;
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
			const bytes = asBuffer(snap?.bytes);
			if (bytes != null) {
				const total = Number.isFinite(snap?.totalBytes) ? snap.totalBytes : bytes.length;
				// A window cannot start before the stream; clamping keeps a bogus
				// total (total < retained bytes) from shifting every offset.
				return { bytes, totalBytes: Math.max(total, bytes.length) };
			}
		}
		const chunks = collector.chunks;
		if (Array.isArray(chunks) && chunks.length > 0) {
			const parts = [];
			for (const chunk of chunks) {
				const buffer = asBuffer(chunk);
				if (buffer == null) {
					parts.length = 0;
					break;
				}
				parts.push(buffer);
			}
			if (parts.length > 0) {
				const bytes = Buffer.concat(parts);
				const total = Number.isFinite(collector.total) ? collector.total : bytes.length;
				return { bytes, totalBytes: Math.max(total, bytes.length) };
			}
		}
	} catch {
		// A collector that cannot be inspected keeps the stock decode.
	}
	return null;
}

/**
 * @param {string} message
 * @param {unknown} error
 */
function createWarn(ctx) {
	let reported = false;
	return (message, error) => {
		if (reported) return;
		reported = true;
		try {
			const logger = ctx?.logger;
			if (typeof logger?.warn === "function") logger.warn(`dsh-utf8-output: ${message}`, error);
			else if (typeof console?.warn === "function") console.warn(`dsh-utf8-output: ${message}`, error);
		} catch {
			// Logging must never break plugin load.
		}
	};
}

/**
 * Re-decode one collector's reads from its retained raw bytes.
 * @param {object} collector OutputCollector instance
 * @param {(message: string, error?: unknown) => void} warn
 */
function patchCollector(collector, warn) {
	if (!collector || collector.__utf8OutputPatched) return;
	try {
		Object.defineProperty(collector, "__utf8OutputPatched", { value: true, configurable: true });
	} catch {
		return;
	}
	// readFrom() is called right after every spawn chunk and finalize() once at
	// the end; both usually describe the same tail. Keep the last decode so the
	// end-of-stream pass is free and repeated polls do not decode twice.
	let memoKey = "";
	let memoText = "";
	const decodeRange = (tail, fromIndex) => {
		const key = `${fromIndex}:${tail.totalBytes}:${tail.bytes.length}`;
		if (key === memoKey) return memoText;
		const text = decodeStreamText(fromIndex === 0 ? tail.bytes : tail.bytes.subarray(fromIndex));
		memoKey = key;
		memoText = text;
		return text;
	};

	const readFrom = typeof collector.readFrom === "function" ? collector.readFrom.bind(collector) : undefined;
	if (readFrom) {
		collector.readFrom = function patchedReadFrom(fromByte) {
			const result = readFrom(fromByte);
			// NaN/undefined would make every offset comparison lie; leave the
			// stock result alone instead of re-sending the whole tail.
			if (result == null || !Number.isFinite(fromByte)) return result;
			try {
				const tail = readTail(collector);
				if (tail == null || tail.bytes.length === 0) return result;
				const windowStart = tail.totalBytes - tail.bytes.length;
				const index = fromByte - windowStart;
				if (index < 0) {
					// The window slid between the stock read and this snapshot. When
					// the stock call still reported a lossless read, its text is the
					// correct slice: re-decoding the tail would duplicate bytes.
					if (result.lossy === false) return result;
					return { ...result, text: decodeRange(tail, 0), lossy: true };
				}
				if (index >= tail.bytes.length) return result;
				return { ...result, text: decodeRange(tail, index), lossy: false };
			} catch (error) {
				warn("failed to re-decode subprocess output", error);
				return result;
			}
		};
	}

	const finalize = typeof collector.finalize === "function" ? collector.finalize.bind(collector) : undefined;
	if (finalize) {
		collector.finalize = function patchedFinalize() {
			const result = finalize();
			try {
				const tail = readTail(collector);
				if (tail != null && tail.bytes.length > 0 && result != null && typeof result === "object") {
					result.text = decodeRange(tail, 0);
				}
			} catch (error) {
				warn("failed to re-decode the final subprocess output", error);
			}
			return result;
		};
	}
}

/**
 * @param {unknown} handle
 * @param {(message: string, error?: unknown) => void} warn
 */
function patchHandle(handle, warn) {
	try {
		patchCollector(handle?.collected?.stdout, warn);
		patchCollector(handle?.collected?.stderr, warn);
	} catch (error) {
		warn("failed to patch the subprocess handle", error);
	}
}

/**
 * @param {object} ctx cordis context
 */
export function apply(ctx) {
	// Windows OEM code pages are the only problem this plugin repairs; on other
	// platforms stock UTF-8 decoding is already correct, so stay a no-op.
	if (process.platform !== "win32") return;
	const warn = createWarn(ctx);
	const service = ctx?.get?.("subprocess") ?? ctx?.subprocess;
	if (!service || typeof service.spawn !== "function") {
		warn("subprocess service unavailable; OEM-codepage repair is inactive");
		return;
	}
	if (service.__utf8OutputBridged) return;
	// A frozen service can take neither the marker nor the wrapper. Check first so
	// the warning names the real cause instead of the assignment TypeError below.
	if (!Object.isExtensible(service)) {
		warn("subprocess service is frozen; OEM-codepage repair is inactive");
		return;
	}
	const spawn = service.spawn;
	const bridgedSpawn = function bridgedSpawn(...args) {
		const handle = spawn.apply(this, args);
		// A few core builds hand back a promise or a thenable; patch whatever
		// settles instead of silently patching a pending object.
		if (handle != null && typeof handle.then === "function") {
			return handle.then(
				(settled) => {
					patchHandle(settled, warn);
					return settled;
				},
				(error) => {
					throw error;
				},
			);
		}
		patchHandle(handle, warn);
		return handle;
	};
	try {
		service.spawn = bridgedSpawn;
	} catch (error) {
		warn("cannot replace subprocess.spawn; OEM-codepage repair is inactive", error);
		return;
	}
	try {
		// Publish the marker only after the wrapper is really installed. Writing it
		// first left "already bridged" behind whenever the assignment threw, and the
		// next load skipped the repair at the check above without any warning.
		Object.defineProperty(service, "__utf8OutputBridged", { value: true, configurable: true });
	} catch (error) {
		// Without a marker the next instance would wrap this one again, so undo the
		// wrapper and stay a stock service instead of double-decoding.
		try {
			service.spawn = spawn;
		} catch {}
		warn("subprocess service is frozen; OEM-codepage repair is inactive", error);
		return;
	}
	const restore = () => {
		try {
			// The marker belongs to our wrapper. Someone else may have re-bridged on
			// top of it, and clearing their marker would let the next load wrap again.
			if (service.spawn !== bridgedSpawn) return;
			service.spawn = spawn;
			delete service.__utf8OutputBridged;
		} catch (error) {
			warn("failed to restore subprocess.spawn", error);
		}
	};
	// Without this, a plugin reload leaves the stale wrapper (and its bridge
	// marker) in place, so the new instance would install nothing.
	if (typeof ctx?.on === "function") ctx.on("dispose", restore);
}
