# MCP Evernote Server

[![Version](https://img.shields.io/npm/v/@verygoodplugins/mcp-evernote)](https://www.npmjs.com/package/@verygoodplugins/mcp-evernote)
[![License](https://img.shields.io/npm/l/@verygoodplugins/mcp-evernote)](LICENSE)

A Model Context Protocol (MCP) server that provides seamless integration with Evernote for note management, organization, and knowledge capture. Works with both Claude Code and Claude Desktop.

**Version:** 1.0.0  
**Release Date:** August 29th, 2025

## Installation Requirements

### For Claude Desktop Users:
- **OAuth Authentication Required**: Yes, run the auth command once (prompts for API keys)
- **Repository Download**: No, you can use npx directly from npm
- **API Credentials**: The auth script will prompt you for your Evernote API keys
- **Simple Setup**: Just one command to authenticate and configure

### For Claude Code Users:
- **OAuth Authentication**: Handled automatically via `/mcp` command
- **Repository Download**: Not required
- **Setup**: Single command installation

## Current Status

### ✅ Working Features

- 🔐 **OAuth Authentication** - Interactive setup for Claude Desktop, automatic for Claude Code
- 📝 **Note Operations**
  - Create notes with plain text or markdown content
  - Read and retrieve note contents
  - Update existing notes
  - Delete notes
  - Automatic Markdown ↔ ENML conversion (GFM + local attachments)
- 📚 **Notebook Management**
  - List all notebooks
  - Create new notebooks
  - Organize with stacks
- 🏷️ **Tag System**
  - List all tags
  - Create new tags
  - Hierarchical tag support
- 🔍 **Advanced Search** - Full Evernote search syntax support
- 👤 **User Info** - Get account details and quota usage
- 🤖 **Smart Setup** - Interactive credential prompts and environment detection

## Quick Start

### Installation Methods

#### Option 1: Using NPX (No Installation Required)

The simplest way - no need to install anything globally:

```bash
# For Claude Desktop - Run authentication
npx -p @verygoodplugins/mcp-evernote mcp-evernote-auth

# For Claude Code - Just add the server
claude mcp add evernote "npx @verygoodplugins/mcp-evernote"
```

#### Option 2: Global Installation

Install once, use anywhere:

```bash
# Install globally
npm install -g @verygoodplugins/mcp-evernote

# For Claude Desktop - Run authentication
mcp-evernote-auth

# For Claude Code - Add the server
claude mcp add evernote "mcp-evernote"
```

#### Option 3: Local Development

For contributing or customization:

```bash
# Clone and install
git clone https://github.com/verygoodplugins/mcp-evernote.git
cd mcp-evernote
npm install

# Run setup wizard
npm run setup
```

## Configuration

### 1. Get Evernote API Credentials

1. Visit [Evernote Developers](https://dev.evernote.com/)
2. Create a new application
3. Copy your Consumer Key and Consumer Secret

### 2. Authentication Options

#### Interactive Setup (Recommended)

The auth script will prompt you for credentials if not found:

```bash
# Run authentication - prompts for API keys if needed
npx -p @verygoodplugins/mcp-evernote mcp-evernote-auth
```

#### Environment Variables (Optional)

For automation, you can set credentials via environment variables:

```env
# Create .env file (optional)
EVERNOTE_CONSUMER_KEY=your-consumer-key
EVERNOTE_CONSUMER_SECRET=your-consumer-secret
EVERNOTE_ENVIRONMENT=production  # or 'sandbox'
OAUTH_CALLBACK_PORT=3000        # Default: 3000
```

### 3. Configure Your Client

<details>
<summary><b>Claude Code Configuration</b></summary>

#### Quick Setup (Using NPX)
```bash
claude mcp add evernote "npx @verygoodplugins/mcp-evernote" \
  --env EVERNOTE_CONSUMER_KEY=your-key \
  --env EVERNOTE_CONSUMER_SECRET=your-secret
```

#### OAuth Authentication
1. In Claude Code, type `/mcp`
2. Select "Evernote"
3. Choose "Authenticate"
4. Follow the browser OAuth flow
5. Tokens are stored and refreshed automatically by Claude Code

**Note:** Claude Code handles OAuth automatically - no manual token management needed!

</details>

<details>
<summary><b>Claude Desktop Configuration</b></summary>

#### Step 1: Authenticate

Using NPX (no installation required):
```bash
npx -p @verygoodplugins/mcp-evernote mcp-evernote-auth
```

The auth script will:
1. Prompt for your API credentials (if not in environment)
2. Optionally save credentials for future use
3. Open your browser for OAuth authentication
4. Save the token to `.evernote-token.json`
5. Display the configuration to add to Claude Desktop

Or if installed globally:
```bash
mcp-evernote-auth
```

#### Step 2: Add to Configuration

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "evernote": {
      "command": "npx",
      "args": ["@verygoodplugins/mcp-evernote"],
      "env": {
        "EVERNOTE_CONSUMER_KEY": "your-consumer-key",
        "EVERNOTE_CONSUMER_SECRET": "your-consumer-secret",
        "EVERNOTE_ENVIRONMENT": "production"
      }
    }
  }
}
```

**Or** if installed globally:
```json
{
  "mcpServers": {
    "evernote": {
      "command": "mcp-evernote",
      "env": {
        "EVERNOTE_CONSUMER_KEY": "your-consumer-key",
        "EVERNOTE_CONSUMER_SECRET": "your-consumer-secret"
      }
    }
  }
}
```

</details>

## Authentication Methods

### 1. Claude Code (Automatic)
Claude Code handles OAuth automatically via the `/mcp` command. Tokens are managed by Claude Code.

### 2. Claude Desktop (Manual)
Run `npx -p @verygoodplugins/mcp-evernote mcp-evernote-auth` to authenticate via browser. Token saved to `.evernote-token.json`.

### 3. Environment Variables (CI/CD)
```env
EVERNOTE_ACCESS_TOKEN=your-token
EVERNOTE_NOTESTORE_URL=your-notestore-url
```

### 4. Direct Token (Advanced)
```json
{
  "env": {
    "EVERNOTE_ACCESS_TOKEN": "your-access-token",
    "EVERNOTE_NOTESTORE_URL": "your-notestore-url"
  }
}
```

## Available Tools

## Markdown Support

This server automatically converts between Markdown and Evernote's ENML format:

- Create/update: Markdown input is rendered to ENML-safe HTML inside `<en-note>`.
  - GFM task lists `- [ ]` map to Evernote checkboxes `<en-todo/>`.
  - Checked tasks `- [x]` map to `<en-todo checked="true"/>`.
-  - Local Markdown images/files (`![alt](./path.png)` or `file://...`) are uploaded as Evernote resources automatically.
-  - Existing attachments are preserved by referencing `evernote-resource:<hash>` in Markdown.
-  - Remote `http(s)` images remain links (download locally if you want them embedded).
-  - Common Markdown elements (headings, lists, code blocks, tables, emphasis, links) are preserved.
- Retrieve: ENML content is converted back to Markdown (GFM), including task lists and attachments.
  - Embedded images become `![alt](evernote-resource:<hash>)` and other files become `[file](evernote-resource:<hash>)` so you can round-trip them safely.

Limitations:
- Remote URLs are not fetched automatically; save them locally and reference the file to embed.
- Keep the `evernote-resource:<hash>` references in Markdown if you want existing attachments to survive edits.
- Some exotic HTML not supported by ENML will be sanitized/removed.

### Note Operations

#### `evernote_create_note`
Create a new note in Evernote.

**Parameters:**
- `title` (required): Note title
- `content` (required): Note content (plain text or markdown)
- `notebookName` (optional): Target notebook name
- `tags` (optional): Array of tag names

**Example:**
```
Create a note titled "Meeting Notes" with content "Discussed Q4 planning" in notebook "Work" with tags ["meetings", "planning"]
```

#### `evernote_search_notes`
Search for notes using Evernote's search syntax.

**Parameters:**
- `query` (required): Search query
- `notebookName` (optional): Limit to specific notebook
- `maxResults` (optional): Maximum results (default: 20, max: 100)

**Example:**
```
Search for notes containing "project roadmap" in the "Work" notebook
```

#### `evernote_get_note`
Retrieve a specific note by GUID.

**Parameters:**
- `guid` (required): Note GUID
- `includeContent` (optional): Include note content (default: true)

> Returned Markdown represents embedded resources with `evernote-resource:<hash>` URLs. Leave those references intact so attachments stay linked when you edit the note.

#### `evernote_update_note`
Update an existing note.

**Parameters:**
- `guid` (required): Note GUID
- `title` (optional): New title
- `content` (optional): New content
- `tags` (optional): New tags (replaces existing)

#### `evernote_delete_note`
Delete a note.

**Parameters:**
- `guid` (required): Note GUID

### Notebook Operations

#### `evernote_list_notebooks`
List all notebooks in your account.

#### `evernote_create_notebook`
Create a new notebook.

**Parameters:**
- `name` (required): Notebook name
- `stack` (optional): Stack name for organization

### Tag Operations

#### `evernote_list_tags`
List all tags in your account.

#### `evernote_create_tag`
Create a new tag.

**Parameters:**
- `name` (required): Tag name
- `parentTagName` (optional): Parent tag for hierarchy

### Account Operations

#### `evernote_get_user_info`
Get current user information and quota usage.

#### `evernote_revoke_auth`
Revoke stored authentication token.

## Search Syntax

Evernote supports advanced search operators:

- `intitle:keyword` - Search in titles
- `notebook:name` - Search in specific notebook
- `tag:tagname` - Search by tag
- `created:20240101` - Search by creation date
- `updated:day-1` - Recently updated notes
- `resource:image/*` - Notes with images
- `todo:true` - Notes with checkboxes
- `-tag:archive` - Exclude archived notes

## Integration with Claude Automation Hub

This MCP server works seamlessly with the Claude Automation Hub for workflow automation:

```javascript
// Example workflow tool
export default {
  name: 'capture-idea',
  description: 'Capture an idea to Evernote',
  handler: async ({ idea, category }) => {
    // The MCP server handles the Evernote integration
    return {
      tool: 'evernote_create_note',
      args: {
        title: `Idea: ${new Date().toISOString().split('T')[0]}`,
        content: idea,
        notebookName: 'Ideas',
        tags: [category, 'automated']
      }
    };
  }
};
```

## Memory Service Integration

To enable synchronization with MCP memory service:

1. Set the memory service URL in your environment:
```env
MCP_MEMORY_SERVICE_URL=http://localhost:8765
```

2. Use the sync tools to persist important notes to memory:
```
Sync my "Important Concepts" notebook to memory for long-term retention
```

## Troubleshooting

### Authentication Issues

#### "Authentication required" error in Claude Desktop
This means you haven't authenticated yet. Run the authentication script:
```bash
npx -p @verygoodplugins/mcp-evernote mcp-evernote-auth
```

Or if installed globally:
```bash
mcp-evernote-auth
```

#### OAuth callback fails
If the OAuth callback doesn't work:
1. Make sure port 3000 is available (or set `OAUTH_CALLBACK_PORT` in `.env`)
2. Check your firewall settings
3. Try using a different browser

#### Token expired
If your token expires:
1. Delete `.evernote-token.json`
2. Run `npx -p @verygoodplugins/mcp-evernote mcp-evernote-auth` again
3. Restart Claude Desktop

### Connection Errors

- Verify your API credentials are correct
- Check if you're using the right environment (sandbox vs production)
- Ensure your firewall allows the OAuth callback port

### Rate Limiting

Evernote API has rate limits. If you encounter limits:
- Reduce the frequency of requests
- Use batch operations where possible
- Implement caching for frequently accessed data

## Development

### Building from Source

```bash
npm install
npm run build
```

### Running in Development Mode

```bash
npm run dev
```

### Testing

```bash
npm test
```

### Linting

```bash
npm run lint
npm run format
```

## Security

- OAuth tokens are stored locally in `.evernote-token.json`
- Never commit token files to version control
- Use environment variables for sensitive configuration
- Tokens expire after one year by default

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

GPL-3.0 - See [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/verygoodplugins/mcp-evernote/issues)

## Acknowledgments

- Built with [Model Context Protocol SDK](https://github.com/anthropics/model-context-protocol)
- Powered by [Evernote API](https://dev.evernote.com/)
- Part of the [Very Good Plugins](https://verygoodplugins.com) ecosystem

## Roadmap

### Near Term
- [ ] **Tag Management** - Add/remove tags from existing notes
- [x] **ENML ↔ Markdown Converter** - Bidirectional conversion between Evernote's ENML format and Markdown
- [ ] **Real-time Sync Hooks** - Detect changes made via Evernote desktop/mobile apps
- [ ] **Database Monitoring** - Watch Evernote DB service for live updates

### Future Enhancements
- [ ] Web clipper functionality
- [ ] Rich text editing support
- [ ] File attachment handling
- [ ] Shared notebook support
- [ ] Business account features
- [ ] Template system
- [ ] Bulk operations
- [ ] Export/Import tools
- [ ] Advanced filtering options
- [ ] Reminder management
