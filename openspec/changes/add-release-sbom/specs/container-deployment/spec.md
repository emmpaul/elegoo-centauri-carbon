# Spec Delta

## ADDED Requirements

### Requirement: SBOM published with each release

When a release tag pushes the image, the system SHALL generate a software bill of
materials in SPDX JSON for each published platform, from the image by the digest it
pushed, and attach it to the GitHub release for the tag as
`elegoo-centauri-carbon-X.Y.Z-linux-<arch>.spdx.json`. Prerelease tags SHALL get SBOMs too.

#### Scenario: Stable release

- **WHEN** tag `v1.2.0` is pushed and the image is pushed
- **THEN** the `v1.2.0` release has the assets `elegoo-centauri-carbon-1.2.0-linux-amd64.spdx.json` and `elegoo-centauri-carbon-1.2.0-linux-arm64.spdx.json`
- **AND** each is a valid SPDX JSON document whose subject is the image digest for that platform

#### Scenario: Prerelease

- **WHEN** tag `v1.3.0-rc.1` is pushed and the image is pushed
- **THEN** the `v1.3.0-rc.1` prerelease has both `elegoo-centauri-carbon-1.3.0-rc.1-linux-<arch>.spdx.json` assets

#### Scenario: Contents of the SBOM

- **WHEN** an SBOM asset is read
- **THEN** it lists the operating system packages of the image, the Node runtime, and the npm packages installed in the image

#### Scenario: No image pushed

- **WHEN** verification fails or the image job fails
- **THEN** no SBOM is generated and no SBOM asset is attached

### Requirement: SBOM listed in the release notes

The release notes SHALL keep the generated notes and end with a "Software bill of
materials" section naming the image pinned by its digest, linking each platform's SBOM
asset, and stating the format and the tool and version that produced it. Re-running the
release workflow for a tag SHALL NOT add the section twice.

#### Scenario: Notes after a release

- **WHEN** the release workflow for `v1.2.0` completes
- **THEN** the release notes contain the generated notes followed by one "Software bill of materials" section with `ghcr.io/emmpaul/elegoo-centauri-carbon@sha256:<digest>` and a link to each SBOM asset

#### Scenario: Workflow re-run

- **WHEN** the SBOM step is re-run for a release that already has the section and assets
- **THEN** the assets are replaced and the notes still contain exactly one "Software bill of materials" section
