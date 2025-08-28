#!/usr/bin/env node

import * as Evernote from 'evernote';
import { EvernoteAPI } from './dist/evernote-api.js';

// Get token from environment
const token = process.env.EVERNOTE_ACCESS_TOKEN;
const noteStoreUrl = process.env.EVERNOTE_NOTESTORE_URL;

if (!token || !noteStoreUrl) {
  console.error('Missing required environment variables: EVERNOTE_ACCESS_TOKEN and EVERNOTE_NOTESTORE_URL');
  process.exit(1);
}

async function testOperations() {
  try {
    console.log('Testing other Evernote operations...');
    
    // Create client using the default export
    const EvernoteModule = Evernote.default || Evernote;
    const client = new EvernoteModule.Client({
      token,
      sandbox: false
    });
    
    const tokens = {
      accessToken: token,
      noteStoreUrl
    };
    
    const api = new EvernoteAPI(client, tokens);
    
    // Test 1: List notebooks
    console.log('\n1. Testing list notebooks...');
    try {
      const notebooks = await api.listNotebooks();
      console.log(`   ✓ Found ${notebooks.length} notebooks`);
      if (notebooks.length > 0) {
        console.log(`   First notebook: ${notebooks[0].name}`);
      }
    } catch (error) {
      console.error('   ✗ Error:', error.message);
    }
    
    // Test 2: List tags
    console.log('\n2. Testing list tags...');
    try {
      const tags = await api.listTags();
      console.log(`   ✓ Found ${tags.length} tags`);
      if (tags.length > 0) {
        console.log(`   First tag: ${tags[0].name}`);
      }
    } catch (error) {
      console.error('   ✗ Error:', error.message);
    }
    
    // Test 3: Get user info
    console.log('\n3. Testing get user info...');
    try {
      const user = await api.getUser();
      console.log(`   ✓ User: ${user.name || user.username}`);
      console.log(`   ID: ${user.id}`);
    } catch (error) {
      console.error('   ✗ Error:', error.message);
    }
    
    // Test 4: Create and delete a test note
    console.log('\n4. Testing note creation and deletion...');
    try {
      const noteContent = {
        title: 'MCP Test Note - ' + new Date().toISOString(),
        content: 'This is a test note created by the MCP Evernote server test suite.'
      };
      
      const createdNote = await api.createNote(noteContent);
      console.log(`   ✓ Created note: ${createdNote.title}`);
      
      // Now delete it
      await api.deleteNote(createdNote.guid);
      console.log(`   ✓ Deleted test note`);
    } catch (error) {
      console.error('   ✗ Error:', error.message);
    }
    
    console.log('\n✅ All operations tests completed!');
    
  } catch (error) {
    console.error('Test failed with error:', error);
    process.exit(1);
  }
}

testOperations();