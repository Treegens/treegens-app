import { converterConfigured, CONVERT_KINDS_TEXT, convertedLine } from '@/lib/convert';

// "Can I add a Word file?" on /help, true for this server: with a converter set up by the people who run it, what
// happens to the file and what to check; without one, the one thing to do. The words are in src/lib/convert.ts.
export function WordFilesHelp() {
  return (
    <article className="pub-qa" id="word-files">
      <h3>Can I add a Word file?</h3>
      {converterConfigured() ? (
        <>
          <p>Yes. Add it like a PDF. We turn {CONVERT_KINDS_TEXT} into a PDF and show it to you before you place a field, with the line &ldquo;{convertedLine('Contract.docx')}&rdquo; The PDF is what people see and sign. Fonts, page breaks and line ends can come out differently from your file, so look at every page.</p>
          <p>If the file has tracked changes or comments, accept or remove them first: the PDF shows them as they print. Your original file is kept with the document and you can download it again from More next to the file. Signers never see it.</p>
        </>
      ) : (
        <p>Save it as a PDF first (in Word: File, Save as, PDF) and add the PDF. We take PDF, PNG and JPEG files. The PDF is what people see and sign, so you see the exact pages before you send.</p>
      )}
    </article>
  );
}
