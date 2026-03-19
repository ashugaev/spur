function writeLine(stream: NodeJS.WriteStream, message: string): void {
  stream.write(`${message}\n`);
}

export function writeStdout(message: string): void {
  writeLine(process.stdout, message);
}

export function writeStderr(message: string): void {
  writeLine(process.stderr, message);
}
