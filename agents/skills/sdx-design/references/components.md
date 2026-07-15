# SDX Components — Full API Reference

Package: `@swisscom/sdx` v3.19.0 (Stencil web components)

---

## `<sdx-button>`

| Property | Type | Default | Description |
|---|---|---|---|
| `theme` | `"primary" \| "secondary" \| "confirm" \| "transparent" \| "cancel" \| "chip"` | `"primary"` | Visual theme |
| `background` | `"light" \| "dark"` | `"light"` | Use `"dark"` on colored backgrounds |
| `disabled` | `boolean` | `false` | Disabled state |
| `href` | `string` | — | Renders as link |
| `target` | `string` | — | Link target |
| `label` | `string` | — | Button text |
| `iconName` | `string` | — | Icon identifier |
| `iconSize` | `string` | — | Icon size (only for transparent/icon-only) |
| `srHint` | `string` | — | Screen reader text |
| `badge` | `string` | — | Badge text |
| `loading` | `boolean` | `false` | Shows spinner, disables button |
| `size` | `"small" \| "normal"` | `"normal"` | Button size |
| `ariaExpandedOnButton` | `boolean` | — | Sets aria-expanded |

Methods: `doFocus()`

### `<sdx-button-group>`

| Property | Type | Description |
|---|---|---|
| `layout` | `"responsive" \| "responsive-center" \| "fixed" \| "fullwidth" \| "fill" \| "responsive-fill"` | Button distribution |

---

## `<sdx-input>`

| Property | Type | Default | Description |
|---|---|---|---|
| `type` | `"text" \| "password" \| "search" \| "textarea" \| "email" \| "date" \| "tel" \| "url" \| "number"` | `"text"` | Input type |
| `value` | `string` | — | Current value |
| `placeholder` | `string` | — | Placeholder |
| `label` | `string` | — | Label text |
| `disabled` | `boolean` | `false` | Disabled |
| `readonly` | `boolean` | `false` | Read-only but focusable |
| `required` | `boolean` | `false` | Required field |
| `valid` | `boolean` | — | `false` = invalid state |
| `validationMessage` | `string` | — | Error message |
| `maxlength` | `number` | — | Max chars (shows counter) |
| `minRows` | `number` | — | Textarea min rows |
| `autofocus` | `boolean` | `false` | Auto-focus on render |
| `selectTextOnFocus` | `boolean` | `false` | Select all on focus |
| `loading` | `boolean` | `false` | Spinner (search type) |
| `flatpickrOptions` | `object` | — | Date picker config |
| `name` | `string` | — | Form name |
| `autocomplete` | `string` | — | HTML autocomplete |
| `inputmode` | `"decimal"` | — | Mobile keyboard |
| `srHint` | `string` | — | Screen reader hint |

Events: `input`, `focus`, `blur`, `sdxsearch` (on Enter for search type)
Methods: `doFocus()`, `doBlur()`

---

## `<sdx-select>`

| Property | Type | Default | Description |
|---|---|---|---|
| `placeholder` | `string` | — | Empty state text |
| `multiple` | `boolean` | `false` | Multi-select |
| `label` | `string` | — | Label |
| `disabled` | `boolean` | `false` | Disabled |
| `loading` | `boolean` | `false` | Loading spinner |
| `keyboardBehavior` | `"focus" \| "filter" \| "autocomplete"` | `"focus"` | Typing behavior |
| `value` | `any[]` | `[]` | Selected values (always array) |
| `valid` | `boolean` | — | Validation state |
| `validationMessage` | `string` | — | Error message |
| `required` | `boolean` | `false` | Required |
| `maxHeight` | `string \| number` | — | Dropdown max height |
| `noMatchesFoundLabel` | `string` | `"No matches found"` | Empty results |
| `filterInputPlaceholder` | `string` | `"Type to filter…"` | Filter placeholder |
| `filterMinLength` | `number` | `1` | Min filter length |
| `filterFunction` | `function` | — | Custom filter |
| `backgroundTheme` | `"light" \| "dark"` | `"light"` | Background |
| `srHint` | `string` | — | SR hint |

Events: `input`, `focus`, `blur`, `sdxfilter`, `sdxsearch`
Methods: `open()`, `close()`, `toggle()`, `doFocus()`
Slots: `infotip`, default (options)

### `<sdx-select-option>`

| Property | Type | Description |
|---|---|---|
| `value` | `any` | Option value |
| `selected` | `boolean` | Initially selected |
| `disabled` | `boolean` | Not selectable |
| `displayText` | `string` | Override display when selected |

### `<sdx-select-optgroup>`

| Property | Type | Description |
|---|---|---|
| `name` | `string` | Group label |
| `selected` | `boolean` | Initially selected |
| `disabled` | `boolean` | Disables group |

---

## `<sdx-dialog>`

| Property | Type | Default | Description |
|---|---|---|---|
| `label` | `string` | — | Dialog title |
| `type` | `"modal" \| "closable-modal"` | `"modal"` | Modal behavior |
| `iconName` | `string` | — | Header icon |
| `iconColorClass` | `string` | — | Icon color class |
| `notificationType` | `"info" \| "success" \| "warning" \| "error"` | — | Colors header |
| `alignHeaderCenter` | `boolean` | `false` | Center header |

Events: `sdxdisplaychange` → `{ display: "open" | "opening" | "closed" | "closing" }`
Methods: `open()`, `close()`, `toggle()`

### `<sdx-dialog-toggle>`
Wraps trigger element (must be sibling of `<sdx-dialog>`).

### `<sdx-dialog-content>`
Wraps dialog body content.

---

## `<sdx-tabs>`

| Property | Type | Default | Description |
|---|---|---|---|
| `theme` | `"left-aligned" \| "centered" \| "minimal"` | `"left-aligned"` | Layout |
| `size` | `"small" \| "normal"` | `"normal"` | Tab size (minimal only) |
| `srHint` | `string` | — | SR description |

Events: `sdxselect`
Methods: `layout(animated: boolean)`

### `<sdx-tabs-item>`

| Property | Type | Default | Description |
|---|---|---|---|
| `label` | `string` | — | Tab title |
| `selected` | `boolean` | `false` | Active tab |
| `disabled` | `boolean` | `false` | Not selectable |
| `badge` | `string` | — | Badge text |
| `srHintBadge` | `string` | — | Badge SR label |
| `iconName` | `string` | — | Tab icon |
| `href` | `string` | — | Deep link |

Events: `sdxselect`

---

## `<sdx-accordion>`

| Property | Type | Default | Description |
|---|---|---|---|
| `keepOpen` | `boolean` | `false` | Allow multiple open |
| `theme` | `"" \| "borderless"` | `""` | Style variant |

Methods: `open(index)`, `close(index)`, `toggle(index)`, `openAll()`, `closeAll()`

### `<sdx-accordion-item>`
Property: `open` (boolean)

### `<sdx-accordion-item-header>`
Methods: `openItem()`, `closeItem()`

### `<sdx-accordion-item-body>`
Event: `sdxdisplaychange`

### `<sdx-accordion-item-section>`
Wrapper for content groups (no props).

---

## `<sdx-input-group>`

| Property | Type | Default | Description |
|---|---|---|---|
| `type` | `"checkbox" \| "radio"` | — | Input variant |
| `theme` | `"none" \| "container" \| "indicator-less"` | `"none"` | Visual style |
| `label` | `string` | — | Group label |
| `value` | `any[]` | `[]` | Checked values |
| `inline` | `boolean` | `false` | Horizontal layout (max 2) |
| `valid` | `boolean` | — | Validation state |
| `validationMessage` | `string` | — | Error message |
| `required` | `boolean` | `false` | Required |
| `name` | `string` | — | Form name |

Events: `input`, `focus`, `blur`
Slots: `infotip`, default (items)

### `<sdx-input-item>`

| Property | Type | Description |
|---|---|---|
| `type` | `"checkbox" \| "radio"` | Inherits from parent |
| `value` | `any` | Item value |
| `checked` | `boolean` | Checked state |
| `indeterminate` | `boolean` | Indeterminate (checkbox) |
| `disabled` | `boolean` | Disabled |
| `iconName` | `string` | Icon (container theme) |
| `iconSize` | `string` | Icon size |
| `imageSrc` | `string` | Image URL |
| `imageAlt` | `string` | Image alt text |
| `srHint` | `string` | Screen reader hint |

Slots: `description`, `right`, `infotip`, default (label text)

---

## `<sdx-icon>`

| Property | Type | Default | Description |
|---|---|---|---|
| `iconName` | `string` | — | Icon identifier (e.g. `"icon-044-home"`) |
| `size` | `1-6` | (inherits) | 1=16px, 2=24px, 3=32px, 4=40px, 5=48px, 6=56px |
| `srHint` | `string` | `""` | Screen reader text |
| `colorClass` | `string` | `""` | SDX color class |
| `gradient` | `boolean` | `false` | Gradient effect |

---

## `<sdx-loading-spinner>`

No documented properties — just renders a spinner.

## `<sdx-loading-bar>`

No documented properties — renders a progress bar.

---

## `<sdx-switch>`

Toggle switch component. Use for on/off settings.

---

## `<sdx-tooltip>`

Tooltip component for contextual help.

---

## `<sdx-card>`

Card container for focused content.

---

## `<sdx-badge>`

Badge for counts/notifications.

---

## `<sdx-tag>`

Tag/label component.

---

## `<sdx-divider>`

Visual separator.

---

## `<sdx-expand>`

Expand/collapse content.

---

## `<sdx-show-more>`

Show more/less toggle.

---

## `<sdx-search>`

Search input component.

---

## `<sdx-numeric-stepper>`

Number input with +/- controls.

---

## `<sdx-progress-stepper>`

Multi-step progress indicator.

---

## `<sdx-scroll-to-top>`

Scroll-to-top button.

---

## `<sdx-content-slider>`

Carousel/content slider.

---

## `<sdx-price>`

Price display component.

---

## `<sdx-status-indicator>`

Status badge with semantic colors.

---

## `<sdx-sticker>`

Promotional sticker component.

---

## `<sdx-skip-links>`

Accessibility skip navigation links.

---

## `<sdx-header>`

| Property | Type | Description |
|---|---|---|
| `apps` | `string` | App switcher config |
| `hideBreadcrumbs` | `boolean` | Hide breadcrumbs |
| `navigation` | `string` | Navigation config JSON |
| `login` | `string` | Login config |
| `skipLinkMainContentElementId` | `string` | Main content element ID |

Events: `sdxnavigate`, `sdxnotificationdisplaychange`, `sdxslotdisplaychange`
Methods: `showNotification()`, `showToast()`, `openSlot()`, `closeSlot()`, `getNavigationHelpers()`

---

## `<sdx-footer>`

Footer component.

---

## Common Patterns

**Validation:** All form components use `valid` + `validationMessage` pair.
**Events:** Custom events use `sdx*` prefix: `sdxselect`, `sdxsearch`, `sdxfilter`, `sdxdisplaychange`.
**Methods:** Most interactive components expose `open()`, `close()`, `toggle()`, `doFocus()`.
**SR hints:** Use `srHint` attribute for accessibility labels.
