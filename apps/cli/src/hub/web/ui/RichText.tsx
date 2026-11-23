/** Renders `code` spans from backticks. Text is never parsed as HTML. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        // Index keys are stable: the parts are derived from one string, in order.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        index % 2 === 0 ? part : <code key={index}>{part}</code>,
      )}
    </>
  );
}
