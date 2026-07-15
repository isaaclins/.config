# SDX Design Tokens — CSS Variables Reference

Package: `@swisscom/sdx` v3.19.0

## Surface (Backgrounds)

```
--sdx-color-surface-ui-1                      #ffffff
--sdx-color-surface-ui-2                      #f6f6f9
--sdx-color-surface-ui-3                      #f2f1f8

--sdx-color-surface-interaction-default       #0445c8
--sdx-color-surface-interaction-hover         #0036a7
--sdx-color-surface-interaction-inactive      #7aafff
--sdx-color-surface-interaction-inverse       #c3dbff
--sdx-color-surface-interaction-onEmphasis    #9bc3ff

--sdx-color-surface-general-emphasis          #4c93ff
--sdx-color-surface-general-muted             #e8f1ff

--sdx-color-surface-success-emphasis          #5bbf53
--sdx-color-surface-success-muted             #d7ffd2
--sdx-color-surface-success-hover             #0d6f2c

--sdx-color-surface-warning-emphasis          #f1bf00
--sdx-color-surface-warning-muted             #fff7c9
--sdx-color-surface-warning-hover             #785e03

--sdx-color-surface-error-emphasis            #ff855a
--sdx-color-surface-error-muted               #fcece5
--sdx-color-surface-error-hover               #ba3e06

--sdx-color-surface-neutral-emphasis          #55545b
--sdx-color-surface-neutral-muted             #dbdae1
--sdx-color-surface-neutral-hover             #b7b6bc
```

## Border Colors

```
--sdx-color-border-interaction-default        #0445c8
--sdx-color-border-interaction-hover          #0036a7
--sdx-color-border-interaction-inactive       #7aafff

--sdx-color-border-general-emphasis           #4c93ff
--sdx-color-border-general-muted              #e8f1ff

--sdx-color-border-success-emphasis           #5bbf53
--sdx-color-border-success-muted              #d7ffd2

--sdx-color-border-warning-emphasis           #f1bf00
--sdx-color-border-warning-muted              #fff7c9

--sdx-color-border-error-emphasis             #ff855a
--sdx-color-border-error-muted                #fcece5

--sdx-color-border-neutral-1                  #55545b
--sdx-color-border-neutral-2                  #cecdd3
--sdx-color-border-neutral-hover              #222126
--sdx-color-border-neutral-inactive           #b7b6bc
--sdx-color-border-neutral-inverse            #dbdae1
--sdx-color-border-neutral-focus              #3b3a3f
```

## Text Colors

```
--sdx-color-text-interaction-default          #0445c8
--sdx-color-text-interaction-hover            #0036a7
--sdx-color-text-interaction-inactive         #7aafff

--sdx-color-text-general-emphasis             #4c93ff
--sdx-color-text-general-muted                #e8f1ff

--sdx-color-text-success-emphasis             #5bbf53
--sdx-color-text-success-muted                #d7ffd2

--sdx-color-text-warning-emphasis             #f1bf00
--sdx-color-text-warning-muted                #fff7c9

--sdx-color-text-error-emphasis               #ff855a
--sdx-color-text-error-muted                  #fcece5

--sdx-color-text-neutral-default              #55545b
--sdx-color-text-heading                      #001155
--sdx-color-text-body                         #222126
--sdx-color-text-inactive                     #b7b6bc
--sdx-color-text-inverse                      #ffffff
--sdx-color-text-onEmphasis                   #ffffff
```

## Icon Colors

```
--sdx-color-icon-interaction-default          #0445c8
--sdx-color-icon-interaction-hover            #0036a7
--sdx-color-icon-interaction-inactive         #7aafff

--sdx-color-icon-general-emphasis             #4c93ff
--sdx-color-icon-general-muted                #e8f1ff
--sdx-color-icon-general-onEmphasis           #0036a7

--sdx-color-icon-success-emphasis             #5bbf53
--sdx-color-icon-success-muted                #d7ffd2
--sdx-color-icon-success-onEmphasis           #045300

--sdx-color-icon-warning-emphasis             #f1bf00
--sdx-color-icon-warning-muted                #fff7c9
--sdx-color-icon-warning-onEmphasis           #5f4a02

--sdx-color-icon-error-emphasis               #ff855a
--sdx-color-icon-error-muted                  #fcece5
--sdx-color-icon-error-onEmphasis             #892c01

--sdx-color-icon-neutral-emphasis             #222126
--sdx-color-icon-neutral-muted                #b7b6bc
--sdx-color-icon-default                      #001155
--sdx-color-icon-inverse                      #ffffff
--sdx-color-icon-onEmphasis                   #ffffff
```

## Border Radius

```
--sdx-border-radius-small                     4px
--sdx-border-radius-medium                    8px
--sdx-border-radius-large                     12px
--sdx-border-radius-xlarge                    20px
--sdx-border-radius-full                      80px
```

## Border Width

```
--sdx-border-width-thin                       1px
--sdx-border-width-medium                     2px
--sdx-border-width-thick                      4px
--sdx-border-style-default                    solid
```

## Box Shadows (Elevation)

```
--sdx-boxShadow-layer1       rgba(85,84,91,0.24) 0px 0px 32px 0px
--sdx-boxShadow-layer2       rgba(85,84,91,0.4) 0px 0px 56px 4px
```

Layer rules:
- Background → no shadow
- Layer 1 → standard elevated elements (cards, panels)
- Layer 2 → overlays on top of Layer 1 (modals, dialogs)

## Spacing

```
--sdx-spacing-0               2px
--sdx-spacing-1               4px
--sdx-spacing-1dot5           6px
--sdx-spacing-2               8px
--sdx-spacing-2dot5           12px
--sdx-spacing-3               16px
--sdx-spacing-4               24px
--sdx-spacing-5               32px
--sdx-spacing-6               40px
--sdx-spacing-7               64px
--sdx-spacing-8               80px
```

SDX utility classes (NO tw: prefix — these are SDX native):
- `.margin-{0-4}` / `.padding-{0-4}` (0=0px, 1=8px, 2=16px, 3=24px, 4=32px)
- `.margin-h-{0-4}` / `.margin-v-{0-4}` (horizontal / vertical)
- `.margin-top-*`, `.margin-bottom-*`, `.margin-left-*`, `.margin-right-*`
- Responsive: `.margin-md-h-1`, `.padding-lg-v-2`

## Breakpoints

```
--sdx-breakpoint-mobile-default               360px
--sdx-breakpoint-mobile-wide                  480px
--sdx-breakpoint-tablet-default               768px
--sdx-breakpoint-tablet-wide                  1024px
--sdx-breakpoint-desktop-default              1440px
--sdx-breakpoint-desktop-wide                 1920px
```

Grid breakpoints: xs=0, sm=480px, md=768px, lg=1024px, xl=1280px, ul=1440px

## Icon Sizes

```
--sdx-iconSize-xsmall         16px    (size="1")
--sdx-iconSize-small          24px    (size="2")
--sdx-iconSize-medium         32px    (size="3")
--sdx-iconSize-large          40px    (size="4")
--sdx-iconSize-xlarge         48px    (size="5")
--sdx-iconSize-xxlarge        56px    (size="6")
```

## Typography Variables

Font: TheSans (weights: 400=regular, 600=semibold, 700=bold)

```
--sdx-font-display-xl-fontSize / lineHeight / letterSpacing / fontWeight
--sdx-font-display-l-fontSize  / lineHeight / letterSpacing / fontWeight
--sdx-font-display-m-fontSize  / lineHeight / letterSpacing / fontWeight
--sdx-font-display-s-fontSize  / lineHeight / letterSpacing / fontWeight

--sdx-font-heading-xxl-fontSize / lineHeight / letterSpacing / fontWeight
--sdx-font-heading-xl-fontSize  / lineHeight / letterSpacing / fontWeight
--sdx-font-heading-l-fontSize   / lineHeight / letterSpacing / fontWeight
--sdx-font-heading-m-fontSize   / lineHeight / letterSpacing / fontWeight
--sdx-font-heading-s-fontSize   / lineHeight / letterSpacing / fontWeight
--sdx-font-heading-xs-fontSize  / lineHeight / letterSpacing / fontWeight

--sdx-font-body-base-fontSize / lineHeight / letterSpacing
--sdx-font-body-s-fontSize    / lineHeight / letterSpacing
--sdx-font-body-xs-fontSize   / lineHeight / letterSpacing
```

Shorthand style variables:
```
--sdx-font-style-semilight-body-base   = 400 16px/24 thesans
--sdx-font-style-semibold-heading-m    = 600 24px/32 thesans
--sdx-font-style-bold-heading-xxl      = 700 40px/48 thesans
--sdx-font-style-semibold-display-l    = 600 80px/88 thesans
```

## Header Heights

```
--sdx-header-height-mobile
--sdx-header-height-mobile-with-breadcrumbs
--sdx-header-height-desktop
--sdx-header-height-desktop-without-meta
--sdx-header-height-desktop-with-breadcrumbs
--sdx-header-height-desktop-with-breadcrumbs-without-meta
--sdx-header-height-sticky
```
