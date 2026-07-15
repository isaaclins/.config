---
name: sdx-design
description: "SDX (Swisscom Digital Experience) design system skill. Use SDX web components (<sdx-*>) for all UI elements (buttons, inputs, selects, dialogs, tabs, accordions, icons, etc.) and Tailwind CSS with tw: prefix for layout, spacing, and custom styling. Triggers: building UI, creating components, styling pages, designing layouts in Swisscom projects."
---

# SDX Design System + Tailwind Layout

Use **SDX web components** for interactive UI elements. Use **Tailwind CSS** (prefix: `tw:`) for layout, spacing, sizing, and any styling not covered by SDX.

## Setup Requirements

```html
<body class="sdx">
```

```js
import { defineCustomElements } from '@swisscom/sdx/dist/js/webcomponents/loader';
import { setAssetPath } from '@swisscom/sdx/dist/js/webcomponents/esm';
import '@swisscom/sdx/dist/css/webcomponents.min.css';

defineCustomElements();
setAssetPath('/assets/sdx/');
```

Tailwind config must use `tw:` prefix:

```js
// tailwind.config.js
export default {
  prefix: 'tw:',
  // ...
}
```

## Core Rule: SDX for Components, Tailwind for Layout

| Need | Use | Example |
|------|-----|---------|
| Button | SDX | `<sdx-button theme="primary">Save</sdx-button>` |
| Input field | SDX | `<sdx-input label="Email" placeholder="you@example.com"></sdx-input>` |
| Dropdown | SDX | `<sdx-select label="Country">...</sdx-select>` |
| Checkbox/Radio | SDX | `<sdx-input-group theme="checkbox">...</sdx-input-group>` |
| Dialog/Modal | SDX | `<sdx-dialog label="Confirm">...</sdx-dialog>` |
| Tabs | SDX | `<sdx-tabs>...</sdx-tabs>` |
| Accordion | SDX | `<sdx-accordion>...</sdx-accordion>` |
| Icons | SDX | `<sdx-icon icon-name="icon-077-search" size="3"></sdx-icon>` |
| Loading | SDX | `<sdx-loading-spinner></sdx-loading-spinner>` |
| Flexbox layout | Tailwind | `class="tw:flex tw:gap-4 tw:items-center"` |
| Grid layout | Tailwind | `class="tw:grid tw:grid-cols-3 tw:gap-6"` |
| Spacing | Tailwind | `class="tw:p-4 tw:mt-8"` |
| Sizing | Tailwind | `class="tw:w-full tw:max-w-md"` |
| Responsive | Tailwind | `class="tw:flex tw:flex-col md:tw:flex-row"` |
| Custom colors beyond SDX tokens | Tailwind | `class="tw:bg-gray-50"` |

## SDX Grid (Alternative to Tailwind Grid)

SDX has its own 12-column grid. Use it OR Tailwind grid — don't mix both on the same layout:

```html
<div class="container">
  <div class="row">
    <div class="col-md-6">Left</div>
    <div class="col-md-6">Right</div>
  </div>
</div>
```

SDX grid classes do NOT take the `tw:` prefix — they're from SDX CSS.

## SDX Button Reference

```html
<!-- Themes: primary, secondary, confirm, cancel, transparent, chip -->
<sdx-button theme="primary">Primary</sdx-button>
<sdx-button theme="secondary" size="small">Small Secondary</sdx-button>
<sdx-button theme="confirm" icon-name="icon-check">Confirm</sdx-button>
<sdx-button disabled>Disabled</sdx-button>
<sdx-button loading>Loading...</sdx-button>
<sdx-button href="/page" target="_blank">Link Button</sdx-button>

<!-- Button Group -->
<sdx-button-group layout="responsive">
  <sdx-button theme="primary">Save</sdx-button>
  <sdx-button theme="secondary">Cancel</sdx-button>
</sdx-button-group>
```

## SDX Select Reference

```html
<sdx-select label="Choose option" placeholder="Select...">
  <sdx-select-optgroup label="Group A">
    <sdx-select-option value="1">Option 1</sdx-select-option>
    <sdx-select-option value="2">Option 2</sdx-select-option>
  </sdx-select-optgroup>
</sdx-select>

<!-- With autocomplete -->
<sdx-select label="Search" keyboard-behavior="autocomplete" filterable>
  <sdx-select-option value="ch">Switzerland</sdx-select-option>
</sdx-select>

<!-- Multiple -->
<sdx-select label="Tags" multiple>
  <sdx-select-option value="a">Tag A</sdx-select-option>
</sdx-select>
```

## SDX Input Group (Checkbox/Radio)

```html
<!-- Checkboxes -->
<sdx-input-group type="checkbox" label="Features" theme="checkbox">
  <sdx-input-item value="wifi" checked>WiFi</sdx-input-item>
  <sdx-input-item value="5g">5G</sdx-input-item>
</sdx-input-group>

<!-- Radio -->
<sdx-input-group type="radio" label="Plan" theme="radio">
  <sdx-input-item value="basic">Basic</sdx-input-item>
  <sdx-input-item value="pro" checked>Pro</sdx-input-item>
</sdx-input-group>
```

## SDX Dialog

```html
<sdx-dialog id="my-dialog" label="Confirm deletion" type="modal">
  <p>Are you sure you want to delete this item?</p>
  <sdx-button-group slot="actions">
    <sdx-button theme="confirm" onclick="document.getElementById('my-dialog').close()">Delete</sdx-button>
    <sdx-button theme="secondary" onclick="document.getElementById('my-dialog').close()">Cancel</sdx-button>
  </sdx-button-group>
</sdx-dialog>

<!-- Open via JS -->
<script>document.getElementById('my-dialog').open()</script>
```

## SDX Tabs

```html
<sdx-tabs>
  <sdx-tabs-item label="Overview" selected>
    <p>Overview content</p>
  </sdx-tabs-item>
  <sdx-tabs-item label="Details">
    <p>Details content</p>
  </sdx-tabs-item>
  <sdx-tabs-item label="Settings" icon-name="icon-cog">
    <p>Settings content</p>
  </sdx-tabs-item>
</sdx-tabs>
```

## SDX Accordion

```html
<sdx-accordion>
  <sdx-accordion-item>
    <sdx-accordion-item-header>Section 1</sdx-accordion-item-header>
    <sdx-accordion-item-body>Content 1</sdx-accordion-item-body>
  </sdx-accordion-item>
  <sdx-accordion-item open>
    <sdx-accordion-item-header>Section 2 (open)</sdx-accordion-item-header>
    <sdx-accordion-item-body>Content 2</sdx-accordion-item-body>
  </sdx-accordion-item>
</sdx-accordion>
```

## SDX Notifications

```html
<!-- Toast (via header component) -->
<sdx-header id="header"></sdx-header>
<script>
  document.getElementById('header').showToast({
    type: 'confirmation', // info | confirmation | warning | alert
    message: 'Changes saved successfully'
  });
</script>
```

## SDX Icons

```html
<sdx-icon icon-name="icon-077-search" size="3" sr-hint="Search"></sdx-icon>
<!-- size: 1=16px, 2=24px, 3=32px, 4=40px, 5=48px, 6=56px (omit to inherit font-size) -->
<!-- Always provide sr-hint for accessibility -->
<!-- Icon names use format: icon-{number}-{name} e.g. icon-044-home, icon-022-close -->
```

## Colors: Use SDX Functional Tokens

Prefer CSS custom properties over Tailwind colors for themed elements:

```css
/* Surfaces (backgrounds) */
background: var(--sdx-color-surface-ui-1);            /* #ffffff - main bg */
background: var(--sdx-color-surface-ui-2);            /* #f6f6f9 - subtle bg */
background: var(--sdx-color-surface-ui-3);            /* #f2f1f8 - accent bg */
background: var(--sdx-color-surface-interaction-default); /* #0445c8 - primary */
background: var(--sdx-color-surface-success-muted);   /* #d7ffd2 - success bg */
background: var(--sdx-color-surface-error-muted);     /* #fcece5 - error bg */
background: var(--sdx-color-surface-warning-muted);   /* #fff7c9 - warning bg */

/* Text */
color: var(--sdx-color-text-heading);                 /* #001155 - headings */
color: var(--sdx-color-text-body);                    /* #222126 - body text */
color: var(--sdx-color-text-neutral-default);         /* #55545b - secondary */
color: var(--sdx-color-text-inactive);                /* #b7b6bc - disabled */
color: var(--sdx-color-text-inverse);                 /* #ffffff - on dark */
color: var(--sdx-color-text-interaction-default);     /* #0445c8 - links */
color: var(--sdx-color-text-error-emphasis);          /* #ff855a - errors */
color: var(--sdx-color-text-success-emphasis);        /* #5bbf53 - success */

/* Borders */
border-color: var(--sdx-color-border-neutral-2);      /* #cecdd3 - default */
border-color: var(--sdx-color-border-neutral-1);      /* #55545b - strong */
border-color: var(--sdx-color-border-neutral-hover);  /* #222126 - hover */
border-color: var(--sdx-color-border-neutral-focus);  /* #3b3a3f - focus */
border-color: var(--sdx-color-border-interaction-default); /* #0445c8 - active */
border-color: var(--sdx-color-border-error-emphasis); /* #ff855a - error */
border-color: var(--sdx-color-border-success-emphasis); /* #5bbf53 - success */

/* Icons */
color: var(--sdx-color-icon-default);                 /* #001155 */
color: var(--sdx-color-icon-interaction-default);     /* #0445c8 */
color: var(--sdx-color-icon-neutral-muted);           /* #b7b6bc */
```

### Border & Radius Tokens

```css
border-width: var(--sdx-border-width-thin);           /* 1px */
border-width: var(--sdx-border-width-medium);         /* 2px */
border-width: var(--sdx-border-width-thick);          /* 4px */
border-style: var(--sdx-border-style-default);        /* solid */

border-radius: var(--sdx-border-radius-small);        /* 4px */
border-radius: var(--sdx-border-radius-medium);       /* 8px */
border-radius: var(--sdx-border-radius-large);        /* 12px */
border-radius: var(--sdx-border-radius-xlarge);       /* 20px */
border-radius: var(--sdx-border-radius-full);         /* 80px */
```

### Elevation (Box Shadows)

```css
box-shadow: var(--sdx-boxShadow-layer1);  /* rgba(85,84,91,0.24) 0 0 32px 0 — cards */
box-shadow: var(--sdx-boxShadow-layer2);  /* rgba(85,84,91,0.4) 0 0 56px 4px — modals */
```

## Typography

Font: **TheSans** (weights: 400, 600, 700). Classes have NO `tw:` prefix:

| Class | Mobile | Desktop | Weight |
|-------|--------|---------|--------|
| `.hero` | 70px/80px | 96px/104px | 700 |
| `.d1` | 54px/64px | 70px/80px | 700 |
| `.d2` | 48px/56px | 54px/64px | 700 |
| `.d3` | 40px/48px | 48px/56px | 700 |
| `.h1` | 32px/40px | 40px/48px | 700 |
| `.h2` | 28px/32px | 32px/40px | 700 |
| `.h3` | 24px/32px | 28px/32px | 600 |
| `.h4` | 20px/24px | 24px/32px | 600 |
| `.h5` | 18px/24px | 18px/24px | 600 |
| `.h6` | 16px/24px | 16px/24px | 600 |
| body | 18px/24px | 18px/24px | 400 |
| `.text-small` | 16px/21px | 16px/21px | 400 |
| `.text-smaller` | 14px/18px | 14px/18px | 400 |

```html
<h1 class="h1">Heading 1</h1>
<p class="text-small">Small text</p>
<span class="hero">Hero display</span>
```

## Spacing

SDX spacing scale (CSS variables):

| Variable | Value |
|----------|-------|
| `--sdx-spacing-0` | 2px |
| `--sdx-spacing-1` | 4px |
| `--sdx-spacing-2` | 8px |
| `--sdx-spacing-3` | 16px |
| `--sdx-spacing-4` | 24px |
| `--sdx-spacing-5` | 32px |
| `--sdx-spacing-6` | 40px |
| `--sdx-spacing-7` | 64px |
| `--sdx-spacing-8` | 80px |

SDX utility classes (NO `tw:` prefix):

```html
<div class="margin-top-2 padding-3">...</div>
<!-- Class scale: 0=0px, 1=8px, 2=16px, 3=24px, 4=32px -->
<!-- Directions: margin-h-*, margin-v-*, margin-top-*, margin-bottom-* -->
<!-- Responsive: margin-md-h-1, padding-lg-v-2 -->
```

Use SDX spacing utilities OR Tailwind spacing (`tw:mt-4 tw:p-6`) — be consistent within a component.

## Grid

12-column flexbox grid. Breakpoints:

| Name | Min-width | Container |
|------|-----------|-----------|
| xs | 0 | fluid |
| sm | 480px | 452px |
| md | 768px | 756px |
| lg | 1024px | 972px |
| xl | 1280px | 1224px |
| ul | 1440px | 1380px |

```html
<div class="container">
  <div class="row row--gutters">
    <div class="col-md-6 col-lg-4">...</div>
    <div class="col-md-6 col-lg-8">...</div>
  </div>
</div>
```

## Accessibility

- All `<sdx-icon>` must have `sr-hint` attribute
- Use `<sdx-input>` with `label` attribute (built-in association)
- SDX components have ARIA built in — don't add redundant aria-* attributes
- Use `<sdx-skip-links>` at page top for keyboard navigation
- Components auto-translate based on `<html lang="de|fr|it|en">`

## Framework Integration

### Angular
```typescript
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
@NgModule({ schemas: [CUSTOM_ELEMENTS_SCHEMA] })
```

### React
```tsx
// Events use sdx* prefix: onSdxselect, onSdxchange
<sdx-tabs onSdxselect={(e) => handleTab(e)}>
```

### Vue
```js
// vite.config.js
vue({ template: { compilerOptions: { isCustomElement: tag => tag.startsWith('sdx-') } } })
```

## When to Load References

- Need full token list (all surfaces, borders, text, icon colors) → read `references/tokens.md`
- Need complete icon names list → read `references/icons.md`
- Need all component props/events/methods → read `references/components.md`

## Anti-Patterns

- NEVER use `<button>` — use `<sdx-button>`
- NEVER use `<select>` — use `<sdx-select>`
- NEVER use `<input type="checkbox">` — use `<sdx-input-group theme="checkbox">`
- NEVER style SDX components with Tailwind color/typography classes (use SDX tokens)
- NEVER mix SDX grid and Tailwind grid in the same layout
- NEVER omit `class="sdx"` on body
- NEVER forget `defineCustomElements()` initialization
