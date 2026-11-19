import { nextTick, type ObjectDirective } from 'vue'

type State = { sync: () => void; destroy: () => void }
const states = new WeakMap<HTMLSelectElement, State>()

export const globalSelect: ObjectDirective<HTMLSelectElement> = {
  mounted(select) {
    if (select.multiple) return
    const wrapper = document.createElement('span')
    wrapper.className = 'global-select'
    select.after(wrapper)
    select.classList.add('global-select-native')
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'global-select-trigger'
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-expanded', 'false')
    const label = document.createElement('span')
    trigger.append(label)
    const arrow = document.createElement('span')
    arrow.className = 'global-select-chevron'
    arrow.setAttribute('aria-hidden', 'true')
    trigger.append(arrow)
    wrapper.append(trigger)
    const panel = document.createElement('div')
    panel.className = 'global-select-panel'
    panel.hidden = true
    const search = document.createElement('input')
    search.type = 'search'
    search.className = 'global-select-search'
    search.placeholder = 'Cari pilihan...'
    search.setAttribute('aria-label', 'Cari pilihan')
    const list = document.createElement('div')
    list.className = 'global-select-list'
    list.setAttribute('role', 'listbox')
    panel.append(search, list)
    document.body.append(panel)
    let open = false
    const close = () => { open = false; panel.hidden = true; trigger.setAttribute('aria-expanded', 'false') }
    const position = () => {
      const box = trigger.getBoundingClientRect()
      const below = window.innerHeight - box.bottom
      panel.style.width = `${box.width}px`
      panel.style.left = `${box.left}px`
      panel.style.maxHeight = `${Math.max(120, Math.min(300, Math.max(below, box.top) - 8))}px`
      panel.style.top = below >= 220 || below >= box.top ? `${box.bottom + 4}px` : 'auto'
      panel.style.bottom = below < 220 && below < box.top ? `${window.innerHeight - box.top + 4}px` : 'auto'
    }
    const render = () => {
      list.replaceChildren()
      const query = search.value.trim().toLocaleLowerCase()
      for (const [index, option] of Array.from(select.options).entries()) {
        if (option.hidden || !option.text.toLocaleLowerCase().includes(query)) continue
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'global-select-option'
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(option.selected))
        item.disabled = option.disabled || Boolean(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)
        const text = document.createElement('span'); text.textContent = option.text
        item.append(text)
        if (option.selected) { const check = document.createElement('span'); check.className = 'global-select-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true'); item.append(check) }
        item.addEventListener('click', () => { select.selectedIndex = index; select.dispatchEvent(new Event('change', { bubbles: true })); sync(); close(); trigger.focus() })
        list.append(item)
      }
      if (!list.childElementCount) { const empty = document.createElement('div'); empty.className = 'global-select-empty'; empty.textContent = 'Pilihan tidak ditemukan'; list.append(empty) }
    }
    const sync = () => {
      label.textContent = select.selectedOptions[0]?.text || 'Pilih opsi'
      trigger.disabled = select.disabled
      trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('label')?.childNodes[0]?.textContent?.trim() || 'Pilih opsi')
      trigger.setAttribute('aria-invalid', String(!select.validity.valid && select.matches(':user-invalid')))
      if (open) { render(); position() }
    }
    trigger.addEventListener('click', () => { if (open) { close(); return }; open = true; search.value = ''; render(); position(); panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); search.focus() })
    search.addEventListener('input', render)
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus() }
      if (event.key === 'ArrowDown' && event.target === search) { event.preventDefault(); list.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if (index >= 0) { event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus() } }
    })
    const outside = (event: Event) => { if (open && !wrapper.contains(event.target as Node) && !panel.contains(event.target as Node)) close() }
    const reposition = () => { if (open) position() }
    const invalid = () => { trigger.setAttribute('aria-invalid', 'true'); trigger.focus() }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    select.addEventListener('change', sync)
    select.addEventListener('invalid', invalid)
    const observer = new MutationObserver(sync)
    observer.observe(select, { childList: true, subtree: true, attributes: true, characterData: true })
    states.set(select, { sync, destroy: () => { observer.disconnect(); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); panel.remove(); wrapper.remove() } })
    sync()
  },
  updated(select) { void nextTick(() => states.get(select)?.sync()) },
  beforeUnmount(select) { states.get(select)?.destroy(); states.delete(select) }
}
