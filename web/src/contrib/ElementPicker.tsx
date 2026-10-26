import { useId, useState, type KeyboardEvent } from 'react'
import { fold } from '../graph/crypto'

export type Choice = { name: string; emoji: string }

type Props = {
  label: string
  field: 1 | 2
  items: Choice[]
  value: Choice | null
  onChange: (value: Choice | null) => void
}

/**
 * One element of a proposal (AC-CONTRIB-13): a combobox over the plate, filtered by `fold` as you type; a chip dragged
 * from the table or the plate onto it picks it too (Game reads `data-contrib-field`). Text that matches nothing picks
 * nothing.
 */
export function ElementPicker({ label, field, items, value, onChange }: Props) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const q = fold(query)
  const options = q ? items.filter((it) => fold(it.name).includes(q)) : items
  const shown = open && options.length > 0

  const close = () => {
    setOpen(false)
    setQuery('')
    setActive(-1)
  }
  const pick = (it: Choice) => {
    onChange(it)
    close()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => Math.min(options.length - 1, Math.max(0, a + step)))
    } else if (e.key === 'Enter' && shown && active >= 0 && options[active]) {
      e.preventDefault() // picks the option, does not send the form
      pick(options[active])
    } else if (e.key === 'Escape') {
      close()
    }
  }

  return (
    <div className="contrib-pick" data-contrib-field={field}>
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className="contrib-pick-box">
        {value && (
          <span className="contrib-picked">
            <span aria-hidden="true">{value.emoji}</span> {value.name}
            <button type="button" className="contrib-unpick" aria-label={`Bỏ chọn ${label}`} onClick={() => onChange(null)}>
              ✕
            </button>
          </span>
        )}
        <input
          id={`${id}-input`}
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={`${id}-list`}
          aria-activedescendant={shown && active >= 0 ? `${id}-opt-${active}` : undefined}
          placeholder={value ? 'Đổi món' : 'Gõ tên hoặc kéo món vào'}
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={close}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {shown && (
        <ul className="contrib-options" role="listbox" id={`${id}-list`} aria-label={label}>
          {options.map((it, i) => (
            <li
              key={it.name}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              // keeps the focus in the input, so its blur does not close the list before the click lands
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(it)}
            >
              <span aria-hidden="true">{it.emoji}</span> {it.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
