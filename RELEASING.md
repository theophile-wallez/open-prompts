# Releasing

Releases are published to npm by the [Release workflow](.github/workflows/release.yml) when a version tag is pushed. It uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token is stored anywhere, and npm attaches a provenance statement that ties each version to this repository and workflow.

## One-time setup

npm configures trusted publishing in the settings of a package that already exists, so the first version is published by hand.

1. Create the free `open-prompts` organization on npmjs.com, which owns the `@open-prompts` scope.

2. Publish the first version from your machine. `publishConfig` in `package.json` makes it public:

   ```sh
   npm login
   npm publish
   ```

3. On npmjs.com, open **Packages → @open-prompts/cli → Settings → Trusted publishing**, choose **GitHub Actions**, and fill in:

   | Field | Value |
   | :- | :- |
   | Organization or user | `theophile-wallez` |
   | Repository | `open-prompts` |
   | Workflow filename | `release.yml` |
   | Environment | `npm` |

   The configuration expires if no publish goes through it within 2 days, so release the next version soon after.

4. Recommended by npm: once a release went through the workflow, restrict token-based publishing in the package settings, so that only the workflow can publish.

5. Optional: in the GitHub repository, open **Settings → Environments → npm** and add yourself as a required reviewer. Each release then waits for your approval before it reaches npm.

## Each release

1. Make sure `main` is green and up to date.
2. Bump the version. This updates `package.json`, `.claude-plugin/plugin.json` and `gemini-extension.json`, commits, and tags:

   ```sh
   npm version patch   # or minor, or major
   ```

3. Push the commit and the tag:

   ```sh
   git push --follow-tags
   ```

The workflow checks that the tag matches the version, runs the tests, publishes to npm, and creates the GitHub release with generated notes. Claude Code and Gemini CLI read the version from the manifests to offer updates to people who installed the plugin or the extension.
