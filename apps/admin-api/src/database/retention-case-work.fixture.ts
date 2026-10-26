/** Jest's deadline ends observation, not the async test body. Keep ownership until
 * teardown drains that body and releases its services before the next case starts. */
export class RetentionCaseWork {
  private active?: Promise<unknown>;
  private finishing?: Promise<void>;
  private sealed = false;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active || this.finishing || this.sealed)
      return Promise.reject(
        new Error('Previous retention case has not drained.'),
      );
    const pending = Promise.resolve().then(work);
    this.active = pending;
    return pending;
  }

  finish(cleanup: () => Promise<void>): Promise<void> {
    if (this.finishing) return this.finishing;
    this.sealed = true;
    const pending = this.active;
    const completion = (async () => {
      const failures: unknown[] = [];
      if (pending) {
        try {
          await pending;
        } catch (error) {
          failures.push(error);
        }
      }
      let released = false;
      try {
        await cleanup();
        released = true;
      } catch (error) {
        failures.push(error);
      }
      this.active = undefined;
      this.sealed = !released;
      if (failures.length)
        throw new AggregateError(
          failures,
          'Retention case work or cleanup failed.',
        );
    })();
    this.finishing = completion;
    void completion
      .finally(() => {
        this.finishing = undefined;
      })
      .catch(() => undefined);
    return completion;
  }
}
