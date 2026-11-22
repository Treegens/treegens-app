// When the home page video waits for a press instead of playing by itself (src/components/home/HomeVideo.tsx).

export type Connection = { saveData?: boolean; effectiveType?: string };

/** True when the video should stay on its poster: less motion asked for, data saving on, or a slow connection. */
export function holdStill(reduceMotion: boolean, connection: Connection | undefined): boolean {
  if (reduceMotion) return true;
  if (!connection) return false;
  return connection.saveData === true || /^(slow-2g|2g|3g)$/.test(connection.effectiveType || '');
}
