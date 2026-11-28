import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { parseTemplateSource } from "@/lib/templates/manifest";

/**
 * One-click deploy entry point (the "Deploy to Syncbay" button):
 *   /new?template=<owner>/<repo>   or   /new?repo=https://github.com/<owner>/<repo>
 * Signed-out visitors go to sign-in and come back here; signed-in users land in the new-project
 * wizard with the template preselected. Anything else opens the plain wizard.
 */
export default async function NewFromTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const template = first(params.template);
  const repo = first(params.repo);

  // ?template= takes owner/repo only; ?repo= also takes a github.com URL.
  const source = template
    ? /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(template)
      ? parseTemplateSource(template)
      : null
    : repo
      ? parseTemplateSource(repo)
      : null;

  const target = source ? `/dashboard/projects/new?template=${source.fullName}` : "/dashboard/projects/new";
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    const back = source ? `/new?template=${source.fullName}` : "/new";
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(back)}`);
  }
  redirect(target);
}
