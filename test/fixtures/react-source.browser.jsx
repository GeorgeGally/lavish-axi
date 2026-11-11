// A small React app for the source-aware inspection test, bundled as a development build.
import { createRoot } from "react-dom/client";

function Button({ children }) {
  return <button className="cta">{children}</button>;
}

function Hero() {
  return (
    <section id="hero">
      <h1>Spring collection</h1>
      <Button>Shop now</Button>
    </section>
  );
}

createRoot(document.getElementById("root")).render(<Hero />);
