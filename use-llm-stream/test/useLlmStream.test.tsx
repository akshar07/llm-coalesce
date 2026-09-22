import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetRegistryForTests } from "../src/registry.js";
import { useLlmStream, type Fetcher } from "../src/useLlmStream.js";
import { ControllableSource, flush } from "./test-utils.js";

afterEach(() => {
  cleanup();
  __resetRegistryForTests();
});

function Consumer({
  testId,
  streamKey,
  fetcher,
}: {
  testId: string;
  streamKey: string;
  fetcher: Fetcher;
}) {
  const { text, status } = useLlmStream(streamKey, fetcher);
  return <div data-testid={testId}>{`${status}:${text}`}</div>;
}

describe("useLlmStream", () => {
  it("two components mounted together with the same key trigger one fetcher call and see identical streamed text", async () => {
    const source = new ControllableSource<string>();
    const fetcher = vi.fn(() => source);

    render(
      <>
        <Consumer testId="a" streamKey="doc-1" fetcher={fetcher} />
        <Consumer testId="b" streamKey="doc-1" fetcher={fetcher} />
      </>,
    );

    await act(async () => {
      source.push("The liability ");
      source.push("clause is uncapped.");
      source.finish();
      await flush();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("a").textContent).toBe(
      "done:The liability clause is uncapped.",
    );
    expect(screen.getByTestId("b").textContent).toBe(
      "done:The liability clause is uncapped.",
    );
  });

  it("a component mounting after the stream has already started still gets the full text", async () => {
    const source = new ControllableSource<string>();
    const fetcher = vi.fn(() => source);

    const { rerender } = render(
      <Consumer testId="a" streamKey="doc-1" fetcher={fetcher} />,
    );

    await act(async () => {
      source.push("chunk-1 ");
      await flush();
    });

    // A second component mounts mid-stream.
    rerender(
      <>
        <Consumer testId="a" streamKey="doc-1" fetcher={fetcher} />
        <Consumer testId="b" streamKey="doc-1" fetcher={fetcher} />
      </>,
    );

    await act(async () => {
      source.push("chunk-2");
      source.finish();
      await flush();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("a").textContent).toBe("done:chunk-1 chunk-2");
    expect(screen.getByTestId("b").textContent).toBe("done:chunk-1 chunk-2");
  });

  it("does not abort the shared stream when only one of two consumers unmounts", async () => {
    const source = new ControllableSource<string>();
    const fetcher = vi.fn(() => source);

    const { rerender } = render(
      <>
        <Consumer testId="a" streamKey="doc-1" fetcher={fetcher} />
        <Consumer testId="b" streamKey="doc-1" fetcher={fetcher} />
      </>,
    );

    await act(async () => {
      source.push("chunk-1 ");
      await flush();
    });

    // "a" unmounts; "b" is still reading.
    rerender(<Consumer testId="b" streamKey="doc-1" fetcher={fetcher} />);

    await act(async () => {
      source.push("chunk-2");
      source.finish();
      await flush();
    });

    expect(source.wasCancelled()).toBe(false);
    expect(screen.getByTestId("b").textContent).toBe("done:chunk-1 chunk-2");
  });
});
