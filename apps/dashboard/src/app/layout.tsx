import './global.css';
import { SidebarShell } from '../components/sidebar-shell';

export const metadata = {
  title: 'API Gateway Dashboard',
  description: 'Manage your API Gateway',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SidebarShell>{children}</SidebarShell>
      </body>
    </html>
  );
}
