import { GetServerSidePropsContext } from "next";

// TEMPORARY DEBUG (dockhand only, not part of the pull request)
// Writes the diagnostics sent by the service worker to the container log.
export const getServerSideProps = async ({
  query,
  res,
}: GetServerSidePropsContext) => {
  const data = Array.isArray(query.d) ? query.d.join("") : (query.d ?? "");
  console.log(`[share-debug] ${data}`);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.write("ok");
  res.end();

  return { props: {} };
};

export default function ShareDebugLog() {
  return null;
}
