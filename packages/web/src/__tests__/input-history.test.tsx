import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useInputHistory } from "@/hooks/useInputHistory";

function HistoryHarness() {
  const history = useInputHistory("spur:test-history");

  return (
    <div>
      <button onClick={() => history.saveEntry("one")} type="button">
        Save one
      </button>
      <button onClick={() => history.saveEntry("two")} type="button">
        Save two
      </button>
      <button onClick={() => history.saveEntry("three")} type="button">
        Save three
      </button>
      <button onClick={() => history.saveEntry("four")} type="button">
        Save four
      </button>
      <button onClick={() => history.saveEntry("five")} type="button">
        Save five
      </button>
      <button onClick={() => history.saveEntry("six")} type="button">
        Save six
      </button>
      <button onClick={() => history.saveEntry("two")} type="button">
        Save two again
      </button>
      <div>{history.entries.map((entry) => entry.value).join(",")}</div>
    </div>
  );
}

describe("useInputHistory", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps only the last five entries and moves duplicates to the front", () => {
    render(<HistoryHarness />);

    for (const name of ["Save one", "Save two", "Save three", "Save four", "Save five", "Save six"]) {
      act(() => {
        screen.getByRole("button", { name }).click();
      });
    }

    expect(screen.getByText("six,five,four,three,two")).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "Save two again" }).click();
    });

    expect(screen.getByText("two,six,five,four,three")).toBeInTheDocument();
    expect(window.localStorage.getItem("spur:test-history")).toContain('"value":"two"');
    expect(window.localStorage.getItem("spur:test-history")).not.toContain('"value":"one"');
  });
});
