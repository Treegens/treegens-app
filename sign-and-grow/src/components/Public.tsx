'use client';
import Link from 'next/link';
import { Leaf } from './ui';

export function PublicNav() {
  return (
    <header className="nav-top">
      <Link href="/" className="logo"><Leaf color="#1f6f43" size={24} /> Sign&Grow</Link>
      <nav className="row">
        <Link href="/impact" className="btn ghost sm hide-sm">Impact</Link>
        <Link href="/verify" className="btn ghost sm hide-sm">Verify a document</Link>
        <Link href="/developers" className="btn ghost sm hide-sm">API</Link>
        <Link href="/login" className="btn sm">Sign in</Link>
        <Link href="/signup" className="btn primary sm">Start free</Link>
      </nav>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="foot">
      <div className="wrap row between wrap">
        <span className="row"><Leaf color="#1f6f43" size={18} /> Sign&Grow. 100% of subscription revenue goes to Treegens tree planting.</span>
        <span className="row"><Link href="/impact">Impact</Link><Link href="/verify">Verify</Link><Link href="/developers">API</Link></span>
      </div>
    </footer>
  );
}
