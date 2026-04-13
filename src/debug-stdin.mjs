#!/usr/bin/env node
const chunks = [];
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = JSON.parse(chunks.join(''));
console.log(JSON.stringify(stdin.context_window, null, 2));
