import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FeedbackButtons } from "../features/qa/QuestionAnswerPage";

afterEach(cleanup);

test("clicking 👍 votes up", () => {
  const onVote = vi.fn();
  render(<FeedbackButtons onVote={onVote} />);
  fireEvent.click(screen.getByLabelText("有帮助"));
  expect(onVote).toHaveBeenCalledWith("up");
});

test("clicking 👎 votes down", () => {
  const onVote = vi.fn();
  render(<FeedbackButtons onVote={onVote} />);
  fireEvent.click(screen.getByLabelText("没帮助"));
  expect(onVote).toHaveBeenCalledWith("down");
});

test("reflects the current vote as pressed", () => {
  render(<FeedbackButtons value="down" onVote={() => {}} />);
  expect(screen.getByLabelText("没帮助")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("有帮助")).toHaveAttribute("aria-pressed", "false");
});
