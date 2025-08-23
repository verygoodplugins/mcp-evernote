# MCP Evernote Server

A Model Context Protocol (MCP) server that provides seamless integration with Evernote for note management, organization, and knowledge capture.

## Features

- 🔐 **OAuth Authentication** - Secure OAuth flow for Evernote API access
- 📝 **Note Management** - Create, read, update, and delete notes
- 📚 **Notebook Organization** - Manage notebooks and stacks
- 🏷️ **Tag System** - Create and manage tags for better organization
- 🔍 **Advanced Search** - Search notes using Evernote's powerful search syntax
- 💾 **Memory Integration** - Optional sync with MCP memory service for knowledge persistence
- 🔄 **Real-time Sync** - Keep your notes synchronized across all devices

## Installation

### Via npm (Recommended)

```bash
npm install -g @verygoodplugins/mcp-evernote
```

### From Source

```bash
git clone https://github.com/verygoodplugins/mcp-evernote.git
cd mcp-evernote
npm install
npm run build
```

## Configuration

### 1. Get Evernote API Credentials

1. Visit [Evernote Developers](https://dev.evernote.com/)
2. Create a new application
3. Note your Consumer Key and Consumer Secret

### 2. Set Environment Variables

Create a `.env` file in your project directory:

```env
# Required
EVERNOTE_CONSUMER_KEY=your-consumer-key
EVERNOTE_CONSUMER_SECRET=your-consumer-secret

# Optional
EVERNOTE_ENVIRONMENT=production  # or 'sandbox' for testing
OAUTH_CALLBACK_PORT=3000        # Port for OAuth callback
```

### 3. Configure Claude Desktop

Add to your Claude Desktop configuration file:

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

## Authentication

On first use, the server will:
1. Open your browser for Evernote authorization
2. Start a local server to handle the OAuth callback
3. Save the access token for future use

The token is stored in `.evernote-token.json` in your working directory.

## Available Tools

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

### OAuth Issues

If you encounter OAuth problems:
1. Delete `.evernote-token.json`
2. Restart the MCP server
3. Re-authenticate when prompted

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
- **Discussions**: [GitHub Discussions](https://github.com/verygoodplugins/mcp-evernote/discussions)
- **Documentation**: [Wiki](https://github.com/verygoodplugins/mcp-evernote/wiki)

## Acknowledgments

- Built with [Model Context Protocol SDK](https://github.com/anthropics/model-context-protocol)
- Powered by [Evernote API](https://dev.evernote.com/)
- Part of the Very Good Plugins ecosystem

## Roadmap

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