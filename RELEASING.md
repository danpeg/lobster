# Releasing

## 1. Prepare

```bash
git checkout experimental
git pull
npm run security:scan
npm run check:plugin-pack
```

## 2. Promote to main

- Open PR from `experimental` to `main`
- Merge after review and checks pass

## 3. Publish npm package

```bash
cd packages/openclaw-recall-copilot-plugin
npm version patch
npm publish --access public
```

## 4. Tag + Notes

- Create Git tag `vX.Y.Z`
- Publish GitHub release notes
