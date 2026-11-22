# Third-party data and license notices

## caniuse-lite (transitive development dependency)

- **Package:** `caniuse-lite` version `1.0.30001823` (from `package-lock.json`)
- **License:** Creative Commons Attribution 4.0 International (CC BY 4.0)
- **Attribution:** Browser compatibility information is sourced from [Can I Use](https://caniuse.com/).
- **Upstream project:** https://github.com/browserslist/caniuse-lite
- **Upstream license:** https://github.com/browserslist/caniuse-lite/blob/main/LICENSE
- **Upstream attribution guidance:** https://github.com/browserslist/caniuse-lite#license
- **Use:** Transitive build-tool browser compatibility data. Do not describe it as MIT licensed.
- **Distribution check:** Preserve applicable attribution and license information with any redistributed build/data artifacts; review packaging and modifications separately. This notice does not resolve release compliance on its own.

## Security gate policy

`scripts/security-gate.mjs` has one tightly scoped exception for the exact package, version and license above. Other packages declaring CC BY 4.0 or future versions of this package must be evaluated rather than silently accepted. The license scan does not replace a complete legal or dependency-security audit.

**2026-11-22 CI triage:** `main` at `7ecdef1b1f1fd93641c15cb6c24830d2b47cf18b`, [Actions run 44980063547](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44980063547), reached `npm test` and failed the supply-chain gate assertion; lockfile inspection identified the single disallowed `caniuse-lite@1.0.30001823 / CC-BY-4.0` declaration. New PR CI outcome is pending, not claimed as passed here.
