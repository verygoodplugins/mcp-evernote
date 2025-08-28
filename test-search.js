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

async function testSearch() {
  try {
    console.log('Testing Evernote search functionality...');
    
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
    
    // Test 1: Simple search
    console.log('\n1. Testing simple search for "Mastermind"...');
    try {
      const results1 = await api.searchNotes({ 
        words: 'Mastermind', 
        maxNotes: 5 
      });
      console.log(`   ✓ Found ${results1.notes?.length || 0} notes`);
      if (results1.notes && results1.notes.length > 0) {
        console.log(`   First result: ${results1.notes[0].title}`);
      }
    } catch (error) {
      console.error('   ✗ Error:', error.message);
    }
    
    // Test 2: Search with notebook filter
    console.log('\n2. Testing notebook filter...');
    try {
      const notebooks = await api.listNotebooks();
      const mastermindNotebook = notebooks.find(nb => nb.name === 'Mastermind Notes');
      if (mastermindNotebook) {
        const results2 = await api.searchNotes({ 
          words: '*',
          notebookGuid: mastermindNotebook.guid,
          maxNotes: 5
        });
        console.log(`   ✓ Found ${results2.notes?.length || 0} notes in Mastermind Notes notebook`);
      } else {
        console.log('   - Mastermind Notes notebook not found, skipping');
      }
    } catch (error) {
      console.error('   ✗ Error:', error.message);
    }
    
    // Test 3: Search by tag
    console.log('\n3. Testing tag search...');
    try {
      const results3 = await api.searchNotes({ 
        words: 'tag:mastermind', 
        maxNotes: 5 
      });
      console.log(`   ✓ Found ${results3.notes?.length || 0} notes with mastermind tag`);
    } catch (error) {
      console.error('   ✗ Error:', error.message);
    }
    
    // Test 4: General search
    console.log('\n4. Testing general search...');
    try {
      const results4 = await api.searchNotes({ 
        words: '*', 
        maxNotes: 10 
      });
      console.log(`   ✓ Found ${results4.notes?.length || 0} recent notes`);
    } catch (error) {
      console.error('   ✗ Error:', error.message);
    }
    
    console.log('\n✅ Search functionality tests completed!');
    
  } catch (error) {
    console.error('Test failed with error:', error);
    process.exit(1);
  }
}

testSearch();