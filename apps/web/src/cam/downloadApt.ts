export function downloadApt(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.apt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
