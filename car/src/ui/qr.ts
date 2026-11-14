/**
 * The pairing QR code: Project Nayuki's MIT generator (qr-nayuki.ts, vendored; car/kit/VENDORED.md) with
 * medium error correction, as a square matrix of dark (true) and light (false) modules, without the quiet
 * zone (draw-pairing.ts adds it). Pure; costs a few milliseconds, so draw-pairing caches it per text.
 */
import { qrcodegen } from './qr-nayuki';

export function encodeQr(text: string): boolean[][] {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const rows: boolean[][] = [];
  for (let y = 0; y < qr.size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < qr.size; x++) row.push(qr.getModule(x, y));
    rows.push(row);
  }
  return rows;
}
