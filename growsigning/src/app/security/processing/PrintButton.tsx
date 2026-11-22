'use client';

// The browser's own print dialog is where "Save as PDF" lives, on every phone and computer. Nothing is generated
// on the server and nothing is downloaded: what you save is the page you are looking at.
export function PrintButton() {
  return <button type="button" className="btn primary" onClick={() => window.print()}>Print or save as PDF</button>;
}
