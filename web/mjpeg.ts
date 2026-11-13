// Splits an MJPEG (`multipart/x-mixed-replace`) byte stream into JPEG frames.
// The dashboard reads /camera with fetch instead of pointing an <img> at it,
// because an <img> keeps showing the last frame when the stream ends and
// reports no error; reading the stream itself shows when the camera stops.
// No DOM here, so the tests run it in Node.

const CRLF2 = new Uint8Array([13, 10, 13, 10]);
const SOI = new Uint8Array([0xff, 0xd8]);
const EOI = new Uint8Array([0xff, 0xd9]);

/** `--<boundary>` from a multipart content type, or null without one. */
export function delimiterOf(contentType: string | null): Uint8Array | null {
  const match = contentType?.match(/;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined) return null;
  // Some servers already include the leading dashes in the boundary parameter.
  return new TextEncoder().encode(boundary.startsWith("--") ? boundary : `--${boundary}`);
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  outer: for (let i = haystack.indexOf(first as number, from); i !== -1 && i <= haystack.length - needle.length; i = haystack.indexOf(first as number, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Feed it chunks in order; each `push` returns the frames completed so far.
 * With a delimiter, a part ends after its `Content-Length` bytes, or at the
 * next delimiter when the part has no length. Without one, a frame runs from a
 * JPEG start marker to the next end marker.
 */
export class MjpegParser {
  private readonly delimiter: Uint8Array | null;
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(delimiter: Uint8Array | null) {
    this.delimiter = delimiter;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = concat(this.buffer, chunk);
    return this.delimiter === null ? this.byMarkers() : this.byParts(this.delimiter);
  }

  private byParts(delimiter: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (;;) {
      const start = indexOf(this.buffer, delimiter);
      if (start === -1) {
        // Keep only what could be the beginning of a delimiter.
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - delimiter.length + 1));
        return frames;
      }
      const headerEnd = indexOf(this.buffer, CRLF2, start + delimiter.length);
      if (headerEnd === -1) {
        this.buffer = this.buffer.slice(start);
        return frames;
      }
      const headers = new TextDecoder().decode(this.buffer.subarray(start + delimiter.length, headerEnd));
      const length = Number(headers.match(/^content-length:\s*(\d+)\s*$/im)?.[1] ?? Number.NaN);
      const bodyStart = headerEnd + CRLF2.length;
      let bodyEnd: number;
      let next: number;
      if (Number.isFinite(length)) {
        bodyEnd = bodyStart + length;
        next = bodyEnd;
        if (this.buffer.length < bodyEnd) {
          this.buffer = this.buffer.slice(start);
          return frames;
        }
      } else {
        next = indexOf(this.buffer, delimiter, bodyStart);
        if (next === -1) {
          this.buffer = this.buffer.slice(start);
          return frames;
        }
        bodyEnd = next;
        // Drop the line break that ends the part body.
        if (this.buffer[bodyEnd - 2] === 13 && this.buffer[bodyEnd - 1] === 10) bodyEnd -= 2;
      }
      frames.push(this.buffer.slice(bodyStart, bodyEnd));
      this.buffer = this.buffer.slice(next);
    }
  }

  private byMarkers(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (;;) {
      const start = indexOf(this.buffer, SOI);
      if (start === -1) {
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 1));
        return frames;
      }
      const end = indexOf(this.buffer, EOI, start + SOI.length);
      if (end === -1) {
        this.buffer = this.buffer.slice(start);
        return frames;
      }
      frames.push(this.buffer.slice(start, end + EOI.length));
      this.buffer = this.buffer.slice(end + EOI.length);
    }
  }
}
