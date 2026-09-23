# CFX Portal Upload Action

GitHub Action for automatically uploading FiveM resources to the CFX Portal.

<br>

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Deploy to Server](#deploy-to-server)
- [Parameters](#parameters)
- [escrow_ignore](#escrow_ignore)
- [Keeping Cookie Active](#keeping-cookie-active)
- [Troubleshooting](#troubleshooting)

<br>

## Quick Start

### 1. Create Asset on CFX Portal

Go to [portal.cfx.re](https://portal.cfx.re) and create an asset for your
resource. Note the **asset name** — you'll need it later.

### 2. Get Authentication Cookie

1. Open [forum.cfx.re](https://forum.cfx.re) and log in
2. Open browser DevTools (`F12`)
3. Navigate to **Application** → **Cookies** → `https://forum.cfx.re`
4. Find the cookie named `_t` and copy its value

### 3. Add Secret to GitHub

1. Open your repository on GitHub
2. Go to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Set name as `FORUM_COOKIE` and paste the cookie value

### 4. Create Workflow File

Create `.github/workflows/upload.yml`:

```yaml
name: Upload to CFX Portal

on:
  push:
    branches: [main, master]

jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Upload to CFX Portal
        uses: luman-studio/cfx-portal-upload@main
        with:
          cookie: ${{ secrets.FORUM_COOKIE }}
          escrowed: |
            asset_name: "your-resource-name"
```

### 5. Configure fxmanifest.lua

Specify which files should remain unencrypted:

```lua
fx_version 'cerulean'
game 'gta5'

name 'My Resource'
author 'Your Name'
version '1.0.0'
description 'Description of your resource'

escrow_ignore {
  'config.lua',
  'shared/config.lua',
  'locales/*.lua',
}

client_script 'client/*.lua'
server_script 'server/*.lua'
shared_script 'shared/*.lua'
```

### 6. Push Changes

```bash
git add .
git commit -m "My changes"
git push origin main
```

The action will automatically upload your resource to the portal.

<br>

## Configuration

### Escrowed + OpenSource Versions

```yaml
- name: Upload to CFX Portal
  uses: luman-studio/cfx-portal-upload@main
  with:
    cookie: ${{ secrets.FORUM_COOKIE }}
    escrowed: |
      asset_name: "my-resource"
    openSource: |
      asset_name: "my-resource-source"
```

### Monorepo (Multiple Resources)

For repositories containing multiple FiveM resources:

```
my-resources/
├── resource-a/
│   └── fxmanifest.lua
├── resource-b/
│   └── fxmanifest.lua
└── .github/workflows/
    └── upload.yml
```

```yaml
- name: Upload Resource A
  uses: luman-studio/cfx-portal-upload@main
  with:
    cookie: ${{ secrets.FORUM_COOKIE }}
    resourcePath: 'resource-a'
    escrowed: |
      asset_name: "resource-a"

- name: Upload Resource B
  uses: luman-studio/cfx-portal-upload@main
  with:
    cookie: ${{ secrets.FORUM_COOKIE }}
    resourcePath: 'resource-b'
    escrowed: |
      asset_name: "resource-b"
```

<br>

## Deploy to Server

Automatically deploy assets to your FiveM server after uploading to the portal.

### Basic Deploy

```yaml
- name: Upload and Deploy
  uses: luman-studio/cfx-portal-upload@main
  with:
    cookie: ${{ secrets.FORUM_COOKIE }}
    escrowed: |
      asset_name: "my-resource"
    # Deploy configuration
    deploy: true
    ssh_host: ${{ secrets.SERVER_HOST }}
    ssh_user: ${{ secrets.SERVER_USER }}
    ssh_key: ${{ secrets.SSH_KEY }}
    deploy_path: '~/fivem/resources'
```

### Deploy with Custom Resource Name

```yaml
- name: Upload and Deploy
  uses: luman-studio/cfx-portal-upload@main
  with:
    cookie: ${{ secrets.FORUM_COOKIE }}
    escrowed: |
      asset_name: "my-resource-escrowed"
    deploy: true
    ssh_host: ${{ secrets.SERVER_HOST }}
    ssh_user: ${{ secrets.SERVER_USER }}
    ssh_key: ${{ secrets.SSH_KEY }}
    deploy_path: '~/server-data/resources/[scripts]'
    deploy_resource_name: 'my-resource'
```

Deployment follows the `asset_id` and `version_id` returned by CFX for the current
upload. It waits up to roughly five minutes for that exact version and its pack;
missing identities or a timeout fail the action instead of deploying another
active version.

Each deployment first saves the complete current resource directory outside
`deploy_path`. The backup identifier contains the UTC timestamp and the GitHub
ref or commit. Deployment is reported as installed, but not yet verified:
neither deployment nor rollback restarts the server.

To manually restore a backup, run the action with the selected identifier:

```yaml
- name: Roll back resource files
  uses: luman-studio/cfx-portal-upload@main
  with:
    cookie: unused-for-rollback
    deploy: true
    rollback: true
    rollback_backup: '20260923T120000000Z-v1.2.3'
    deploy_resource_name: 'my-resource'
    ssh_host: ${{ secrets.SERVER_HOST }}
    ssh_user: ${{ secrets.SERVER_USER }}
    ssh_key: ${{ secrets.SSH_KEY }}
    deploy_path: '~/server-data/resources'
```

Rollback replaces the whole resource directory, removing files introduced by the
newer release. It restores files only; database data and running process state
are unchanged.

### SSH Key Setup

1. Generate an SSH key:

   ```bash
   ssh-keygen -t ed25519 -C "github-actions" -f github-actions
   ```

2. Add the public key to your server:

   ```bash
   cat github-actions.pub >> ~/.ssh/authorized_keys
   ```

3. Add secrets to GitHub:
   - `SERVER_HOST`: Your server IP or hostname
   - `SERVER_USER`: SSH username
   - `SSH_KEY`: Contents of `github-actions` (private key)

<br>

## Parameters

### Action Inputs

| Parameter              | Type    | Required | Description                                 |
| ---------------------- | ------- | -------- | ------------------------------------------- |
| `cookie`               | string  | Yes      | Value of `_t` cookie from forum.cfx.re      |
| `escrowed`             | yaml    | No       | Escrowed version configuration              |
| `openSource`           | yaml    | No       | Open source version configuration           |
| `resourcePath`         | string  | No       | Path to resource folder (for monorepos)     |
| `skipUpload`           | boolean | No       | Skip upload, authenticate only              |
| `deploy`               | boolean | No       | Enable deploy to server after upload        |
| `ssh_host`             | string  | No       | SSH host address for deployment             |
| `ssh_user`             | string  | No       | SSH username                                |
| `ssh_key`              | string  | No       | SSH private key                             |
| `ssh_port`             | string  | No       | SSH port (default: 22)                      |
| `deploy_path`          | string  | No       | Path to resources folder on server          |
| `deploy_resource_name` | string  | No       | Resource folder name (defaults to asset)    |
| `deploy_backup_path`   | string  | No       | Backup directory outside `deploy_path`      |
| `rollback`             | boolean | No       | Restore a selected backup instead of upload |
| `rollback_backup`      | string  | No       | Backup identifier to restore                |

### Version Configuration

| Parameter    | Description                               |
| ------------ | ----------------------------------------- |
| `asset_name` | Asset name on the portal (case-sensitive) |
| `asset_id`   | Asset ID (alternative to asset_name)      |

<br>

## escrow_ignore

The action preserves your `escrow_ignore` configuration for escrowed versions.
You control which files remain unencrypted through your `fxmanifest.lua`.

For **openSource** versions, the action automatically sets
`escrow_ignore { '**/*' }` so all files remain open.

```lua
escrow_ignore {
  'config.lua',
  'shared/config.lua',
  'locales/*.lua',
}
```

<br>

## Keeping Cookie Active

The cookie may expire due to inactivity. Add a scheduled workflow to keep it
active:

```yaml
name: Refresh Cookie

on:
  schedule:
    - cron: '0 0 * * *'

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - name: Keep cookie alive
        uses: luman-studio/cfx-portal-upload@main
        with:
          cookie: ${{ secrets.FORUM_COOKIE }}
          skipUpload: true
```

<br>

## Troubleshooting

**"No assets found matching..."**

- Verify the asset name matches exactly (case-sensitive)

**"Authentication failed"**

- Cookie has expired — obtain a new one from forum.cfx.re
- Do not log out after copying the cookie; clear it from your browser instead

**"asset must not contain an archive"**

- Archive files (.zip, .rar, .7z) are automatically excluded, but avoid storing
  them in the repository

<br>

## Contributing

1. Fork the repository
2. Create a branch for your changes
3. Make changes
4. Create a Pull Request
