'use client';
import { Dialog } from '@/components/sign/Dialog';
import { FixName } from '@/components/sign/dialogs';

// "Your name": opened by a tap on the person's own name where the document prints it. It says which name the
// document is for and holds "Fix my name", which used to be reachable only in "Check before you finish". That step
// no longer comes when nothing needs a look, so the way to it is the name itself, like a tap on a placed signature.
export function NameDialog({ name, approving, onRename, onClose }: { name: string; approving?: boolean; onRename: (name: string) => Promise<string | void>; onClose: () => void }) {
  return (
    <Dialog title="Your name" onClose={onClose}>
      <p>You are {approving ? 'approving' : 'signing'} as <b><bdi>{name}</bdi></b>. The document prints your name this way.</p>
      <FixName name={name} onRename={onRename} />
      <div className="actions"><button type="button" className="btn" onClick={onClose}>Back to the document</button></div>
    </Dialog>
  );
}
