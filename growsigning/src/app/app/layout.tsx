import { AppShell } from '@/components/AppShell';
import { ShellWorker } from '@/components/ShellWorker';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell><ShellWorker />{children}</AppShell>;
}
