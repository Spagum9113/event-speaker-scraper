import { redirect } from "next/navigation";

export default function Home() {
  // Keep the root route simple and always send users to event history.
  redirect("/events");
}
