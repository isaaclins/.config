# SDX Icons Reference

853 icons available. Use via `<sdx-icon icon-name="icon-XXX-name" size="3" sr-hint="Label"></sdx-icon>`

## Sizes

| size | px | CSS variable |
|------|-----|---|
| 1 | 16px | `--sdx-iconSize-xsmall` |
| 2 | 24px | `--sdx-iconSize-small` |
| 3 | 32px | `--sdx-iconSize-medium` |
| 4 | 40px | `--sdx-iconSize-large` |
| 5 | 48px | `--sdx-iconSize-xlarge` |
| 6 | 56px | `--sdx-iconSize-xxlarge` |

Omit `size` to inherit from current font-size.

## Commonly Used Icons

### Navigation & Actions
```
icon-001-account
icon-002-arrow-down
icon-003-arrow-left
icon-004-arrow-right
icon-005-arrow-up
icon-009-calendar
icon-010-cancel
icon-011-check-mark
icon-013-chevron-down
icon-014-chevron-left
icon-015-chevron-right
icon-016-chevron-up
icon-021-clock
icon-022-close
icon-025-edit
icon-042-group
icon-044-home
icon-050-menu
icon-052-minus
icon-053-more
icon-055-okay
icon-061-plus
icon-065-rename
icon-077-search
icon-078-settings
icon-079-shopping-trolley
icon-080-speech-bubble
icon-082-star
icon-085-synchronise
icon-087-upload
icon-094-warning
icon-095-zoom-in
icon-096-zoom-out
```

### Files & Documents
```
icon-006-attachment
icon-007-backup
icon-008-bin
icon-023-download
icon-024-download-cloud
icon-028-folder-new
icon-074-save
icon-118-document
icon-119-document-new
icon-120-document-excel
icon-121-document-powerpoint
icon-122-document-word
icon-123-document-pdf
icon-124-document-txt
icon-125-document-zip
icon-126-document-code
```

### Devices
```
icon-110-mobile-phone
icon-111-smartphone
icon-112-tablet
icon-113-laptop
icon-114-computer
icon-115-workstation
icon-138-headphone
icon-139-headset
icon-166-tv
```

### Communication
```
icon-051-message
icon-064-record
icon-067-reply-message
icon-069-reply-message-all
icon-127-e-mail
icon-137-handset
icon-163-sms
```

### Media & Playback
```
icon-056-pause
icon-059-play
icon-083-stop
icon-089-volume-fortissimo
icon-090-volume-forte
icon-091-volume-piano
icon-093-volume-mute
icon-128-film-camera
icon-144-movie
icon-148-music
```

### AI
```
icon-686-ai-robot-wink
icon-687-ai-robot
icon-687-ai-write
icon-688-ai-pattern
icon-689-ai-openai
icon-690-ai-magic
icon-691-ai-image
icon-692-ai-robot-crossed-eye
icon-693-ai-chip
icon-694-ai-chatbot
icon-695-ai-binary-code
```

### Status & Feedback
```
icon-094-warning
icon-055-okay
icon-010-cancel
icon-011-check-mark
icon-080-speech-bubble
```

## Usage Examples

```html
<!-- Basic icon -->
<sdx-icon icon-name="icon-077-search" size="3" sr-hint="Search"></sdx-icon>

<!-- Small inline icon -->
<sdx-icon icon-name="icon-022-close" size="1" sr-hint="Close"></sdx-icon>

<!-- Large decorative icon -->
<sdx-icon icon-name="icon-044-home" size="5"></sdx-icon>

<!-- With color class -->
<sdx-icon icon-name="icon-094-warning" color-class="sc-red" sr-hint="Warning"></sdx-icon>

<!-- Inside a button -->
<sdx-button theme="transparent" icon-name="icon-025-edit" sr-hint="Edit item"></sdx-button>
```

## Full icon catalog
All 853 icons available at: `https://sdx.scsstatic.ch/v2.153.0/icons/`
