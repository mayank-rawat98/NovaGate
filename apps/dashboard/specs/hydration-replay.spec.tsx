/**
 * Issue #69: intermittent React #418 ("server rendered HTML didn't match the
 * client") on cold loads. During hydration a host element can suspend while
 * reconciling a child that is not ready yet, as the Next.js flight client's
 * lazy chunk wrappers are when their module is still loading. When that child
 * settles in a microtask, React replays the suspended host element. Next.js
 * 16.1's bundled React did not rewind the hydration cursor before the replay:
 * the element was claimed against its own first child, hydration failed and
 * the tree was client-rendered. The bundled React from Next.js 16.2 rewinds it.
 *
 * This reproduces the mechanism deterministically against the React build
 * the dashboard ships (Next.js' compiled copy, not node_modules/react).
 */
import type * as ReactModule from 'react';
import type * as ReactDomClient from 'react-dom/client';

// React's browser builds schedule work over MessageChannel, which jsdom
// lacks; a timer-backed channel keeps no handles open after the test.
class TimerMessageChannel {
  readonly port1: { onmessage: ((event: { data: unknown }) => void) | null } = {
    onmessage: null,
  };
  readonly port2 = {
    postMessage: (data: unknown) =>
      setTimeout(() => this.port1.onmessage?.({ data }), 0),
  };
}
(globalThis as { MessageChannel?: unknown }).MessageChannel ??=
  TimerMessageChannel;
const React: typeof ReactModule = require('next/dist/compiled/react');
const {
  hydrateRoot,
}: typeof ReactDomClient = require('next/dist/compiled/react-dom/client');
describe('hydration of a host element whose child suspends', () => {
  it.each(['transition', 'default'])(
    'replays without a mismatch (%s hydration)',
    async (mode) => {
      const child = React.createElement('span', null, 'loaded');
      const App = ({ children }: { children: ReactModule.ReactNode }) =>
        React.createElement(
          'main',
          null,
          React.createElement(
            React.Suspense,
            { fallback: null },
            React.createElement(
              'section',
              null,
              React.createElement('div', { id: 'host' }, children),
            ),
          ),
        );
      const container = document.createElement('div');
      document.body.appendChild(container);
      // What the server renders for <App>{child}</App>: a resolved Suspense
      // boundary is delimited by <!--$--> and <!--/$-->.
      container.innerHTML =
        '<main><!--$--><section><div id="host"><span>loaded</span></div></section><!--/$--></main>';
      const serverHtml = container.innerHTML;
      const serverHost = container.querySelector('#host');
      // Already settled, but React cannot know that synchronously: it
      // suspends on the host element, the thenable settles in a microtask and
      // React replays the element, exactly as with a flight lazy wrapper.
      const pending = Promise.resolve(child);
      const errors: string[] = [];
      const hydrate = () =>
        hydrateRoot(
          container,
          React.createElement(
            App,
            null,
            pending as unknown as ReactModule.ReactNode,
          ),
          { onRecoverableError: (error) => errors.push(String(error)) },
        );
      if (mode === 'transition')
        React.startTransition(() => {
          hydrate();
        });
      else hydrate();
      await new Promise((done) => setTimeout(done, 200));

      expect(errors).toEqual([]);
      // Hydration kept the server DOM instead of client-rendering a new tree.
      expect(container.querySelector('#host')).toBe(serverHost);
      expect(container.innerHTML).toBe(serverHtml);
      container.remove();
    },
  );
});
