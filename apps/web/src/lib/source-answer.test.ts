import { expect, it } from "vitest";
import { sourceAnswerText } from "./track-schemas";

it("says what each answer of a Track source means, and the code of any other", () => {
	expect(sourceAnswerText("200")).toBe("Track took the finding");
	expect(sourceAnswerText("404")).toBe("Track doesn't know this key");
	expect(sourceAnswerText("unreachable")).toBe("Track couldn't be reached");
	expect(sourceAnswerText("unreadable")).toBe("Guard couldn't open the saved key");
	expect(sourceAnswerText("503")).toBe("Track answered 503");
});
