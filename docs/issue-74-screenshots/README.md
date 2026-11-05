# Issue #74 screenshot set

The Chromium and WebKit captures cover the topic list, Questions, Files, and chat at 390, 768,
and 1280 CSS pixels in light and dark themes. Filenames follow
`issue74-{browser}-{theme}-{width}-{view}.png`.

The screenshots use the repository's synthetic design-review fixture. Reproduce them and the full
browser validation with:

```sh
PLAYWRIGHT_PORT=51902 PLAYWRIGHT_SCREENSHOT_DIR=/tmp/issue74-rebased-screens pnpm test:browser
```

The browser suite uses Chromium for every test and WebKit for `@csp` cases, including all 12
viewport/theme screenshot runs per browser.
