// The message box: the whole bottom cell, a TanStack Form checked by its command's schema. Enter
// sends, ⇧Enter breaks the line; "/" from anywhere, or File › New Message, puts the cursor in it,
// and so does typing or pasting with no other field taking it.
// It takes dictation: the mic or ⌘D starts one, and the words come after what's in it, dimmed
// until they're done, so several dictations build one message. Enter, ✓ or ⌘D keeps them to edit
// and send; × or Esc drops them. Nothing sends on its own. What's sent says which words were
// dictated, kept through every edit. With `attach`, files dropped anywhere on the window or
// pasted in join it as chips, each uploading at once.
import type { Dictated } from "@switch/brain/commands"
// ↑ in the empty box can call back the last message to edit; Esc puts it down again.
import { useForm } from "@tanstack/react-form"
import type { StandardSchemaV1 } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { useShortcut } from "@ui-sdk/react/shortcuts"
import { Textarea } from "@ui-sdk/react/textarea"
import { useId, useRef, useState } from "react"
import type { ReactNode } from "react"

import type { Stopped } from "../../shared/dictation.ts"
import { choose } from "../brain/files.ts"
import type { Chosen } from "../brain/files.ts"
import { dropFile } from "../brain/outbox-files.ts"
import {
  canDictate,
  cancelDictation,
  dictationQuery,
  startDictation,
  stopDictation,
  takesDictation,
} from "../dictation/dictation.ts"
import { add, edit, insertion, said } from "../dictation/words.ts"
import type { Span } from "../dictation/words.ts"
import { Chip } from "./chip.tsx"
import { Stop } from "./marks.tsx"
import { fixStopped, Listen, Mic, stoppedText } from "./mic.tsx"
import { Button } from "./kit/button.tsx"
import { EMPTY, keepBytes, useBoxDraft } from "./use-box-draft.ts"

/**
 * Puts the cursor in the message box on screen. Every space's page stays mounted, hidden, in a
 * fixed order (app.tsx), so the first box in the page is rarely the open one's.
 */
export const focusBox = () => {
  const boxes = document.querySelectorAll<HTMLTextAreaElement>("[data-box]")
  const shown = [...boxes].find((el) => el.checkVisibility({ visibilityProperty: true }))
  shown?.focus()
}

/** What's sent: the words, and which of them were dictated. */
export interface Words {
  readonly text: string
  readonly dictated?: Dictated
}

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") === true

const over = (e: DragEvent) => {
  if (hasFiles(e)) {
    e.preventDefault()
  }
}

/** Files dropped anywhere on the window, while the box is there. */
const dropsOn = (put: (files: readonly Chosen[]) => void) => {
  const drop = (e: DragEvent) => {
    if (hasFiles(e) && e.dataTransfer) {
      e.preventDefault()
      put(choose(e.dataTransfer.files))
      focusBox()
    }
  }
  return () => {
    window.addEventListener("dragover", over)
    window.addEventListener("drop", drop)
    return () => {
      window.removeEventListener("dragover", over)
      window.removeEventListener("drop", drop)
    }
  }
}

/** The user is typing somewhere else: in a field, or in an open menu, popover or dialog. */
const typingElsewhere = () => {
  const at = document.activeElement
  const field =
    at instanceof HTMLElement && (at.isContentEditable || at.matches("input, textarea, select"))
  return (
    field ||
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    ) !== null
  )
}

/** The window's own single-key shortcuts, which a key typed outside a field means instead. */
const SINGLE_KEYS = new Set(["/"])

/** A key typed with nothing else taking it moves the focus to the box as it goes down, so the key
 * lands there too; ⌘V moves it the same way before the paste. */
const typed = (e: KeyboardEvent) => {
  if (e.isComposing || e.ctrlKey || e.altKey || typingElsewhere()) {
    return
  }
  const paste = e.metaKey && !e.shiftKey && e.key.toLowerCase() === "v"
  // Space on a focused button presses it.
  const pressing =
    e.key === " " && (document.activeElement?.closest("button, a, [role=button]") ?? null) !== null
  const one = [...new Intl.Segmenter().segment(e.key)].length === 1
  const printable = !e.metaKey && one && !SINGLE_KEYS.has(e.key) && !pressing
  if (paste || printable) {
    focusBox()
  }
}

/**
 * Typing with nothing else taking it lands in the box, as Rust's "/" did from anywhere (mac/src/ui/
 * workspace.rs): a printable key without ⌘, ⌃ or ⌥, or ⌘V (`typed`); and a paste that still finds
 * no field (Wispr Flow's transcript among them) is put in the box.
 */
const typesIn = (pasted: (text: string, files: readonly Chosen[]) => void) => {
  const paste = (e: ClipboardEvent) => {
    if (!e.clipboardData || typingElsewhere()) {
      return
    }
    e.preventDefault()
    pasted(e.clipboardData.getData("text/plain"), choose(e.clipboardData.files))
  }
  window.addEventListener("keydown", typed, true)
  document.addEventListener("paste", paste)
  return () => {
    window.removeEventListener("keydown", typed, true)
    document.removeEventListener("paste", paste)
  }
}

const release = (files: readonly Chosen[]) => {
  for (const c of files) {
    if (c.preview !== undefined) {
      URL.revokeObjectURL(c.preview)
    }
  }
}

/** What a row above the box says: what went wrong with the last one sent, or with dictation. */
const Note = ({ text, onClick }: { text: string; onClick?: (() => void) | undefined }) => {
  const look = "flex h-line w-full items-center gap-2 px-3 text-left text-small text-ink line-2-b"
  return onClick ? (
    <Button look="row" onClick={onClick} className="text-small! line-2-b">
      <Stop size={12} />
      <span className="trim">{text}</span>
    </Button>
  ) : (
    <div className={look}>
      <Stop size={12} />
      <span className="trim">{text}</span>
    </div>
  )
}

export const Box = ({
  placeholder,
  schema,
  onSend,
  error,
  attach = false,
  onRecall,
  editing = false,
  onCancel,
  above,
  more = false,
  place,
}: {
  placeholder: string
  schema: StandardSchemaV1<{
    text: string
    dictated: readonly Span[]
    files: readonly Chosen[]
  }>
  onSend: (words: Words, files: readonly Chosen[]) => void
  /** What went wrong with the last one sent. */
  error?: string | undefined
  attach?: boolean
  /** ↑ in the empty box: the words to edit, if there are any. */
  onRecall?: () => string | null
  /** Whether what's in the box is an edit. */
  editing?: boolean
  onCancel?: () => void
  /** Rows over what's typed: what it replies to. */
  above?: ReactNode
  /** The rows above hold words of the user's own, so it can send with nothing typed. */
  more?: boolean
  /** Where its draft is kept: `space:<id>`, `thread:<id>`. */
  place?: string
}) => {
  const id = useId()
  const area = useRef<HTMLTextAreaElement>(null)
  const [stopped, setStopped] = useState<{ why: Stopped; message?: string } | null>(null)
  const listening = useQuery({
    ...dictationQuery,
    select: (l) => (l.field === id ? l : null),
  }).data
  const form = useForm({
    defaultValues: EMPTY,
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: ({ value, formApi }) => {
      onSend(said(value.text, value.dictated), value.files)
      release(value.files)
      formApi.reset()
      setStopped(null)
    },
  })
  useShortcut("/", focusBox)
  useBoxDraft(
    place,
    {
      values: () => form.state.values,
      watch: (l) => {
        const sub = form.store.subscribe(l)
        return () => {
          sub.unsubscribe()
        }
      },
      put: ({ text, dictated, files }) => {
        if (text !== undefined) {
          form.setFieldValue("text", text)
        }
        if (dictated !== undefined) {
          form.setFieldValue("dictated", dictated)
        }
        if (files !== undefined) {
          form.setFieldValue("files", files)
        }
      },
    },
    editing,
  )

  /** The words go after what's in it, as one edit, marked dictated. */
  const heard = (words: string, why?: Stopped, message?: string) => {
    const text = form.getFieldValue("text")
    const put = insertion(text, words)
    if (put) {
      form.setFieldValue("text", text + put.text)
      form.setFieldValue("dictated", add(form.getFieldValue("dictated"), put.span))
    }
    setStopped(why ? { why, ...(message !== undefined && { message }) } : null)
    requestAnimationFrame(() => {
      area.current?.focus()
    })
  }
  const dictate = () => {
    setStopped(null)
    startDictation(id, heard)
    area.current?.focus()
  }
  const submit = () => {
    // Enter while dictating keeps the words, to edit and send.
    if (listening) {
      stopDictation()
      return
    }
    const { text, files } = form.state.values
    if (more && text.trim() === "" && files.length === 0) {
      onSend({ text: "" }, [])
      form.reset()
      setStopped(null)
      return
    }
    void form.handleSubmit()
  }
  const fix = stopped ? fixStopped(stopped.why) : undefined
  const attachFiles = (files: readonly Chosen[]) => {
    if (files.length > 0) {
      keepBytes(files)
      form.setFieldValue("files", (had) => [...had, ...files])
    }
  }
  const remove = (key: string) => {
    form.setFieldValue("files", (had) => {
      release(had.filter((c) => c.id === key))
      return had.filter((c) => c.id !== key)
    })
    void dropFile(key)
  }

  /** A paste that found no field: its files join the box, its words go after what's in it. */
  const pasted = (text: string, files: readonly Chosen[]) => {
    if (attach && files.length > 0) {
      attachFiles(files)
    } else if (text !== "" && !listening) {
      form.setFieldValue("text", (had) => had + text)
    }
    const el = area.current
    el?.focus()
    requestAnimationFrame(() => {
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }

  return (
    <form
      ref={(el) => {
        const dropping = attach && el ? dropsOn(attachFiles)() : undefined
        const typing = typesIn(pasted)
        return () => {
          dropping?.()
          typing()
        }
      }}
      className="@container flex-none line-2-t"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {editing && (
        <div className="flex h-line items-center gap-2 px-3 text-small text-ink2 line-2-b">
          <span className="trim flex-1">Editing</span>
          <Button
            look="key"
            onClick={() => {
              form.reset()
              onCancel?.()
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {error !== undefined && <Note text={error} />}
      {error === undefined && stopped && (
        <Note text={stoppedText(stopped.why, stopped.message)} onClick={fix} />
      )}
      {above}
      <form.Subscribe selector={(s) => s.values.files}>
        {(files) =>
          files.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2.5">
              {files.map((c) => (
                <Chip
                  key={c.id}
                  chosen={c}
                  onRemove={() => {
                    remove(c.id)
                  }}
                />
              ))}
            </div>
          )
        }
      </form.Subscribe>
      {/* The whole cell is the box: a click anywhere in it puts the cursor in the words. */}
      <label className="flex min-h-12 cursor-text items-end gap-1.5 py-2.5 pr-2.5 pl-3 @3xl:px-[max(0.75rem,calc((100%-var(--container-column))/2))]">
        <form.Field name="text">
          {(field) => {
            const text = field.state.value
            const words = listening ? insertion(text, listening.words) : null
            return (
              <span className="group/field relative flex min-w-0 flex-1">
                {text === "" && !words && (
                  // The placeholder, drawn so it can hold "/"'s keycap while the box isn't focused.
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-[1px] flex items-center gap-1.5 truncate text-read text-ink3"
                  >
                    <span className="truncate">{placeholder}</span>
                    <kbd className="flex-none rounded-sm border border-line-2 px-1 font-sans text-caption leading-4 text-ink3 group-focus-within/field:hidden">
                      /
                    </kbd>
                  </span>
                )}
                <Textarea
                  ref={(el: HTMLTextAreaElement | null) => {
                    area.current = el
                    return el && canDictate ? takesDictation(el, dictate) : undefined
                  }}
                  data-box
                  autoFocus
                  autoResize
                  rows={1}
                  name={field.name}
                  value={words ? text + words.text : text}
                  readOnly={Boolean(listening)}
                  onValueChange={(value) => {
                    const dictated = form.getFieldValue("dictated")
                    form.setFieldValue(
                      "dictated",
                      edit(dictated, text, value, area.current?.selectionEnd),
                    )
                    field.handleChange(value)
                  }}
                  onBlur={field.handleBlur}
                  onPaste={(e) => {
                    if (attach && e.clipboardData.files.length > 0) {
                      e.preventDefault()
                      attachFiles(choose(e.clipboardData.files))
                    }
                  }}
                  submitShortcut="enter"
                  onSubmit={submit}
                  onKeyDown={(e) => {
                    if (
                      e.key === "ArrowUp" &&
                      !e.metaKey &&
                      !e.ctrlKey &&
                      !e.altKey &&
                      !e.shiftKey &&
                      text === "" &&
                      !listening &&
                      onRecall
                    ) {
                      const recalled = onRecall()
                      if (recalled !== null) {
                        e.preventDefault()
                        field.handleChange(recalled)
                      }
                    } else if (e.key === "Escape" && editing && !listening) {
                      // Puts the edit down, rather than leaving the space.
                      e.stopPropagation()
                      e.nativeEvent.stopImmediatePropagation()
                      form.reset()
                      onCancel?.()
                    }
                  }}
                  aria-label={placeholder}
                  className={`max-h-60 min-h-key flex-1 resize-none border-0 bg-transparent py-[1px] text-read outline-none select-text ${listening ? "text-ink2" : "text-ink"}`}
                />
              </span>
            )
          }}
        </form.Field>
        {listening && (
          <Listen listening={listening} onCancel={cancelDictation} onDone={stopDictation} />
        )}
        {!listening && canDictate && <Mic onClick={dictate} />}
        {!listening && (
          <form.Subscribe
            selector={(s) =>
              s.values.text.trim() !== "" || s.values.files.length > 0 ? s.canSubmit : more
            }
          >
            {(ready) => (
              <Button look="go" type="submit" disabled={!ready} aria-keyshortcuts="Enter">
                Send
              </Button>
            )}
          </form.Subscribe>
        )}
      </label>
    </form>
  )
}
