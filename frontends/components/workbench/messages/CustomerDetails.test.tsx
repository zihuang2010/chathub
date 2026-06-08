import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CUSTOMER_DETAILS_WIDTH } from "./constants";
import { CustomerDetails } from "./CustomerDetails";

describe("CustomerDetails", () => {
  it("uses the shared compact details width", () => {
    const { container } = render(<CustomerDetails customer={null} quickReplies={[]} />);
    const aside = container.querySelector("aside");

    expect(CUSTOMER_DETAILS_WIDTH).toBe(288);
    expect(aside?.style.width).toBe(`${CUSTOMER_DETAILS_WIDTH}px`);
  });
});
