# Photography

The site currently uses `PhotoFrame` (see `src/components/PhotoFrame.tsx`), which
renders a layered gradient placeholder instead of a photograph. Each placeholder
carries a small label describing the shot that belongs there.

## Swapping in real photos

1. Drop the image in this folder, for example `public/images/margaritaville-deck.jpg`.
2. Replace the `PhotoFrame` usage with a `next/image`:

```tsx
import Image from "next/image";

<div className="relative aspect-[4/3] overflow-hidden rounded-2xl">
  <Image
    src="/images/margaritaville-deck.jpg"
    alt="The pool deck aboard Margaritaville at Sea at sunset"
    fill
    className="object-cover"
    sizes="(min-width: 1024px) 50vw, 100vw"
  />
</div>
```

## What to supply

| Where | Suggested shot |
| --- | --- |
| Home hero (two frames) | A Margaritaville at Sea deck or ship shot, and a Caribbean beach day |
| Home, "Who you are working with" | Portrait of Brent, relaxed, ideally on or near water |
| Home, Margaritaville band | Pool deck, bar, or a signature onboard moment |
| Home, destination cards | One landscape image per destination |
| About hero and body | A second portrait, plus travel photos from real trips |
| Cruises, pinned card | Best available Margaritaville at Sea image |

Aim for landscape crops at 2000px on the long edge, and keep the subject slightly
off centre so text overlays have room.

## Logo

`public/logo-mark.svg` and `src/app/icon.svg` are rebuilds of the supplied logo
art as clean vectors. If you have the original vector file, replace both and
update `src/components/Logo.tsx` to reference it.
