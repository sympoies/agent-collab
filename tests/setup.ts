// Tests run on fixtures only: any real network request fails the test.
globalThis.fetch = () => Promise.reject(new Error("network access is not allowed in tests"));
