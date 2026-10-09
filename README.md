# llm-coalesce

Share one in-flight LLM request and its live token stream across concurrent callers. The provider-agnostic TypeScript library accepts an `AsyncIterable` or `ReadableStream`, so callers can supply their own LLM SDK or transport.

This repository includes the library and a runnable browser demo.

## Projects

| Directory | Purpose |
| --- | --- |
| [llm-coalesce](llm-coalesce/) | Active library: request coalescing, stream multicasting, and registry adapters. |
| [llm-coalesce-demo](llm-coalesce-demo/) | Express server and browser demos comparing independent requests with a shared stream. |

## Run the demo

Install Node.js 18 or later and npm, then run from the repository root:

```sh
cd llm-coalesce-demo
npm ci
npm start
```

Open [the widget demo](http://localhost:3000) or [the microfrontends demo](http://localhost:3000/microfrontends). The default provider streams mock text, so no API key is required. The displayed request counts come from the server.

The demo installs the committed `vendor-packages/llm-coalesce-0.1.0.tgz` archive. You do not need to build the sibling library or download it from the npm registry.

For an optional real Anthropic provider, see the [demo instructions](llm-coalesce-demo/README.md#using-a-real-llm-instead-of-the-mock) and [.env.example](llm-coalesce-demo/.env.example). Set environment variables in your shell or deployment platform; the server does not automatically load `.env` files. Keep API keys out of source control.

## Develop the library

From the repository root:

```sh
cd llm-coalesce
npm ci
npm run typecheck
npm test
npm run build
```

Read the [library documentation](llm-coalesce/README.md) for the API and the [architecture decisions](llm-coalesce/docs/adr/) for design details.

The demo uses a packaged snapshot, so source edits do not immediately change the demo. To refresh it after library changes, build and pack from `llm-coalesce/`:

```sh
npm run build
npm pack --pack-destination ../llm-coalesce-demo/vendor-packages
cd ../llm-coalesce-demo
npm install ./vendor-packages/llm-coalesce-0.1.0.tgz
```

Use the new archive filename if you change the package version, and commit the updated archive and dependency lockfile together.

## Verify the demo

From `llm-coalesce-demo/`:

```sh
npm test
npx playwright install chromium
npm run test:browser
```

The integration tests exercise the real server. The browser check verifies that three separate module graphs produce three requests with isolated registries and one request with a shared window registry.

## React compatibility

`llm-coalesce` works with React and other frameworks. React apps can import the optional `useLlmStream` hook from `llm-coalesce/react` to receive text, status, and errors with subscription cleanup handled automatically. Pass a stable shared coalescer to coordinate components. The core entry point does not import React. See the [React usage guide](llm-coalesce/README.md#react).

## Scope

Requests coalesce only when they share a registry and an exact request key while work is in flight. Include all inputs that affect the response in that key. The window adapter coordinates widgets within one browser tab; cross-tab and distributed coordination are not implemented in this version.

## Further reading

The [demo README](llm-coalesce-demo/README.md#tutorials-in-the-order-this-project-actually-evolved) lists the tutorials in their intended chronological order. The superseded `use-llm-stream` package has been removed; its source remains available in Git history. Historical tutorials describe earlier versions, not the current API.

## License

The library is licensed under [MIT](llm-coalesce/LICENSE). The demo also declares MIT in its package metadata.
