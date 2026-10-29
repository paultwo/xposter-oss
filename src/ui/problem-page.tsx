import { Layout } from "./layout";
import type { Shell } from "./shell";

export function ProblemPage(props: {
  shell: Shell;
  heading: string;
  message: string;
}) {
  return (
    <Layout shell={props.shell}>
      <h1>{props.heading}</h1>
      <p role="alert">{props.message}</p>
      <p>
        <a href="/">Back to drafts</a>
      </p>
    </Layout>
  );
}
