'use client';
import { useEffect, useRef } from 'react';

/** Native modal: Escape, inert background and focus restoration come from the browser. */
export function PortalDialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={label}
      className="portal-dialog"
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
