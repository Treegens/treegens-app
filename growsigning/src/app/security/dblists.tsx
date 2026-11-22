// The database point on /security when FILE_ENCRYPTION_KEY is set: what is encrypted and what stays readable, as two
// short lists instead of one long paragraph (notEncryptedPoint in src/lib/storedfiles.ts gives the words).
export function DatabaseLists({ lists, after }: { lists?: { title: string; items: string[] }[]; after?: string }) {
  if (!lists?.length) return null;
  return (
    <>
      {lists.map((l) => (
        <span key={l.title} style={{ display: 'block', marginTop: 8 }}>
          <span style={{ display: 'block', fontWeight: 600 }}>{l.title}:</span>
          <ul className="pub-sublist">
            {l.items.map((x) => <li key={x}>{x}</li>)}
          </ul>
        </span>
      ))}
      {after && <span style={{ display: 'block', marginTop: 8 }}>{after}</span>}
    </>
  );
}
