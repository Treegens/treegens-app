import Link from 'next/link';
import { dataPlace, notSaid, type DataPlace, type Processor } from '@/lib/dataplace';

// "Where your data is", for /security and for the data processing summary. Every line comes from dataPlace(), which
// reads the settings the server runs on (src/lib/dataplace.ts). Nothing is typed in here that a deployment could
// make untrue: a provider appears because its switch is on, and whatever the operator has not stated is printed as
// "has not said ... Ask them." in its place.

const Unstated = ({ children }: { children: string }) => <span className="pub-unstated">{children}</span>;

/** A value the operator stated, or the sentence that says they did not. */
export const Stated = ({ value, what }: { value: string | null; what: string }) => (value ? <>{value}</> : <Unstated>{notSaid(what)}</Unstated>);

const unnamed: Record<Processor['id'], string> = {
  host: 'The hosting company', mail: 'The mail provider', payments: 'The payment provider', google: 'Google', microsoft: 'Microsoft', sms: 'The text message provider',
};

/** Everyone else who handles data. On a phone each row becomes a card with its labels written out. */
export function ProcessorTable({ d }: { d: DataPlace }) {
  return (
    <table className="pub-data">
      <caption>Who else handles data, and why</caption>
      <thead><tr><th scope="col">Who</th><th scope="col">Where</th><th scope="col">What for</th><th scope="col">What reaches them</th><th scope="col">Whose data</th></tr></thead>
      <tbody>
        {d.processors.map((p) => (
          <tr key={p.id}>
            <th scope="row">{p.name || unnamed[p.id]}{!p.name && <> <Unstated>Not named</Unstated></>}</th>
            <td data-label="Where">{p.country || <Unstated>Not stated</Unstated>}</td>
            <td data-label="What for">{p.purpose}</td>
            <td data-label="What reaches them">{p.data}</td>
            <td data-label="Whose data">{p.who}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function WhereYourDataIs() {
  const d = dataPlace();
  const others = d.processors.filter((p) => p.id !== 'host').flatMap((p) => p.missing);
  return (
    <section className="card pub-trust" id="data" aria-labelledby="data-h">
      <h2 id="data-h">Where your data is</h2>
      <p className="muted">This block is filled in from the settings this server runs on. What its operator has not stated is said as exactly that, not left out.</p>
      <ul className="pub-points">
        <li><b>Who runs this server.</b><span><Stated value={d.operator} what="who they are" /> They are the ones who hold your data, and the ones to ask about it.</span></li>
        <li><b>Where the server and its files are.</b><span><Stated value={d.region} what="where it is hosted" /> {d.host ? <>It runs on machines of {d.host}.</> : <Unstated>{notSaid('which company hosts it')}</Unstated>} The database and every uploaded and signed file are on one disk in that one place. There is one region. You cannot choose another.</span></li>
        <li><b>Backups.</b><span><Stated value={d.backups} what="whether and where backups are kept" /></span></li>
        <li><b>What leaves the server.</b><span>Only what the table below lists, for the reason it gives{d.processors.length > 1 ? '' : ': on this server that is the hosting alone'}. A webhook you set up yourself sends the events you chose to the address you gave. There is no analytics service, no advertising and no AI service behind these pages.</span></li>
      </ul>
      <ProcessorTable d={d} />
      {d.off.length > 0 && <p className="muted small" style={{ margin: '12px 0 0' }}><b>Not in use on this server:</b> {d.off.join(' ')}</p>}
      {/* Who the others are and where: said in full here, because a table cell only has room for "Not stated".
          What is missing about the server itself is said in its own place above. */}
      {others.length > 0 && (
        <div className="notice warn" style={{ marginTop: 14 }} id="data-unstated">
          <b>Not stated about the others who handle data:</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{others.map((u) => <li key={u}>{u}</li>)}</ul>
        </div>
      )}
      <ul className="pub-points" style={{ marginTop: 14 }}>
        <li><b>A summary you can keep, and what a signed agreement would be.</b><span>The <Link href="/security/processing">data processing summary</Link> says what is processed, for whom, for how long and how it is deleted, on one page you can save as a PDF. It is a description, not a contract. If you need a signed data processing agreement, it is between you and whoever runs this server{d.operator ? <>: {d.operator}</> : null}. The software cannot sign one for them.</span></li>
      </ul>
    </section>
  );
}
