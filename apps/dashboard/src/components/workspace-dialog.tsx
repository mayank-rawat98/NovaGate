'use client';

import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

export function containDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Native modal behavior supplies Escape dismissal, inert background, focus
 * containment and focus restoration instead of duplicating them in every form. */
export function WorkspaceDialog({
  label,
  onClose,
  children,
  centered = false,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  centered?: boolean;
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
      onKeyDown={containDialogFocus}
      aria-label={label}
      className={`nova-workspace-dialog ${centered ? 'nova-dialog-centered' : ''}`}
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dialog.current?.close();
        }
      }}
    >
      {children}
    </dialog>
  );
}
