import qrcode from 'qrcode-generator';

/** Renders text as an inline SVG QR code (error correction M, 4-module quiet zone). */
export function qrSvg(text: string, opts: { label?: string } = {}): string {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;
  // One path of horizontal runs keeps the SVG small (a few KB).
  let d = '';
  for (let r = 0; r < n; r += 1) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c += 1;
        continue;
      }
      let end = c;
      while (end < n && qr.isDark(r, end)) end += 1;
      d += `M${c + quiet} ${r + quiet}h${end - c}v1h${-(end - c)}z`;
      c = end;
    }
  }
  const label = (opts.label ?? 'Ticket QR code').replace(/[<>&"]/g, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}
