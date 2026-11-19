## MODIFIED Requirements

### Requirement: Published on release tags

When a `vX.Y.Z` tag passes the release verification, the system SHALL build the image for
`linux/amd64` and `linux/arm64` and push it to `ghcr.io/emmpaul/elegoo-centauri-carbon`
tagged `X.Y.Z`. It SHALL also tag it `latest` only when the tag has no `-` suffix. No other
event SHALL push an image. The GitHub release for the tag SHALL be created only after the
image has been pushed, so a published release always has its image.

#### Scenario: Stable release

- **WHEN** tag `v1.2.0` is pushed and verification passes
- **THEN** the registry has `1.2.0` and `latest` pointing at the same image

#### Scenario: Prerelease

- **WHEN** tag `v1.3.0-rc.1` is pushed and verification passes
- **THEN** the registry has `1.3.0-rc.1` and `latest` is unchanged

#### Scenario: Verification fails

- **WHEN** the tag does not match `package.json` or the tests fail
- **THEN** no image is pushed

#### Scenario: Pull request or branch push

- **WHEN** a pull request runs CI or a branch is pushed
- **THEN** no image is built or pushed

#### Scenario: Release waits for the image

- **WHEN** tag `v1.2.0` is pushed and verification passes
- **THEN** the GitHub release `v1.2.0` is created only after the `1.2.0` image is in the registry

#### Scenario: Image push fails

- **WHEN** tag `v1.2.0` is pushed, verification passes, and the image build or push fails
- **THEN** no GitHub release `v1.2.0` is created
