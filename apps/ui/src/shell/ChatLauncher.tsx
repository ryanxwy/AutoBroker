/**
 * ChatLauncher — the floating chat-head shown ONLY while the chat rail is
 * minimized. A dumb restore handle: clicking it re-expands the rail (App owns
 * the state; the rail itself stays MOUNTED behind display:none, so this
 * component may mount/unmount freely). No badge, no pulse, no count.
 */

export function ChatLauncher({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="chat-launcher"
      data-testid="chat-launcher"
      aria-label="Open chat"
      title="Open chat"
      onClick={onOpen}
    >
      {/* The chat-agent sticker (public/logo/) — decorative, the accessible
          name lives on the button (the BrandMark <img> idiom). */}
      <img src="/logo/chat-agent.svg" alt="" aria-hidden="true" draggable={false} />
    </button>
  );
}
